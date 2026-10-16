import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deleteBuild, parseDeleteBuildArgs } from "./delete-build.ts";
import { lockErrors, type CloudflareLock, type LockFile } from "./lock.ts";
import { deploymentPaths, GENERATED_WRANGLER_CONFIG, SERVER_DIR, type DeploymentPaths } from "./paths.ts";
import { configErrors } from "./validate-config.ts";
import { deploymentWranglerConfig, parseJsonc, type WranglerConfig } from "./wrangler-config.ts";

// Builds, deploys and runs a deployment's Worker from its config-only repository
// (docs/design.md#deployment). The deploy Action and `./drop deploy` / `./drop dev` both run it, with
// DROP_DEPLOYMENT_DIR set to the deployment repository.
//
// Usage: node scripts/deployment.ts deploy [--secrets] [--dry-run]
//        node scripts/deployment.ts dev [-- <wrangler dev args>]
//        node scripts/deployment.ts delete-build <build-id> [--yes]
//        node scripts/deployment.ts wrangler-config

export interface Deployment {
  paths: DeploymentPaths;
  config: { url: string; owners: string[] };
  lock: LockFile & { cloudflare: CloudflareLock };
}

/** Reads and checks a deployment's config and lockfile, failing with every problem at once. */
export function loadDeployment(paths: DeploymentPaths): Deployment {
  if (!existsSync(paths.config)) throw new Error(`${paths.config} doesn't exist. Is DROP_DEPLOYMENT_DIR the deployment repository?`);
  const config = JSON.parse(readFileSync(paths.config, "utf8"));
  const lock = existsSync(paths.lock) ? (JSON.parse(readFileSync(paths.lock, "utf8")) as LockFile) : undefined;
  const schemaErrors = configErrors(config);
  if (schemaErrors.length > 0) throw new Error(schemaErrors.map((error) => `drop.config.json ${error}`).join("\n"));
  const errors = lockErrors(config, lock, { deploy: true });
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { paths, config, lock: lock as Deployment["lock"] };
}

/** Writes the generated Wrangler config next to wrangler.jsonc, so its relative paths still resolve. */
export function writeWranglerConfig(deployment: Deployment): string {
  const base = parseJsonc(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8")) as WranglerConfig;
  const generated = deploymentWranglerConfig(base, {
    url: deployment.config.url,
    cloudflare: deployment.lock.cloudflare,
    configPath: deployment.paths.config,
    lockPath: deployment.paths.lock,
  });
  writeFileSync(GENERATED_WRANGLER_CONFIG, `${JSON.stringify(generated, null, 2)}\n`);
  return GENERATED_WRANGLER_CONFIG;
}

/**
 * The environment wrangler runs with: the lockfile's account, which an explicitly given
 * CLOUDFLARE_ACCOUNT_ID must agree with, so a token for one account can't deploy over another.
 */
export function wranglerEnvironment(cloudflare: CloudflareLock, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const given = env.CLOUDFLARE_ACCOUNT_ID;
  if (given && given !== cloudflare.accountId) {
    throw new Error(`CLOUDFLARE_ACCOUNT_ID is ${given}, but drop.config.lock.json's deployment is on account ${cloudflare.accountId}.`);
  }
  return { ...env, CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId };
}

/** The wrangler commands for a deploy: migrations first, so the new code never meets an old schema. */
export function deploySteps(options: { configFile: string; secretsFile?: string; dryRun?: boolean }): string[][] {
  const deploy = ["deploy", "--config", options.configFile];
  if (options.secretsFile) deploy.push("--secrets-file", options.secretsFile);
  if (options.dryRun) return [[...deploy, "--dry-run"]];
  return [["d1", "migrations", "apply", "DB", "--remote", "--config", options.configFile], deploy];
}

/** The wrangler commands for local development, with state and secrets kept in the deployment repository. */
export function devSteps(options: { configFile: string; devVars: string; localState: string; args?: string[] }): string[][] {
  const persist = ["--persist-to", options.localState];
  return [
    ["d1", "migrations", "apply", "DB", "--local", ...persist, "--config", options.configFile],
    ["dev", "--config", options.configFile, ...persist, ...(existsSync(options.devVars) ? ["--env-file", options.devVars] : []), ...(options.args ?? [])],
  ];
}

function runWrangler(steps: string[][], env: NodeJS.ProcessEnv): void {
  for (const args of steps) {
    const result = spawnSync("npx", ["--no-install", "wrangler", ...args], { cwd: SERVER_DIR, env, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed.`);
  }
}

function captureWrangler(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync("npx", ["--no-install", "wrangler", ...args], { cwd: SERVER_DIR, env, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] });
  if (result.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed.`);
  return result.stdout;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const paths = deploymentPaths();
  const deployment = loadDeployment(paths);
  const configFile = writeWranglerConfig(deployment);
  const env = wranglerEnvironment(deployment.lock.cloudflare, process.env);

  switch (command) {
    case "wrangler-config":
      console.log(configFile);
      return;
    case "deploy": {
      const secrets = args.includes("--secrets");
      if (secrets && !existsSync(paths.devVars)) throw new Error(`--secrets uploads ${paths.devVars}, which doesn't exist; run setup first.`);
      runWrangler(deploySteps({ configFile, secretsFile: secrets ? paths.devVars : undefined, dryRun: args.includes("--dry-run") }), env);
      if (!args.includes("--dry-run")) console.log(`Deployed ${deployment.lock.cloudflare.workerName} to ${deployment.config.url}.`);
      return;
    }
    case "delete-build": {
      const { id, yes } = parseDeleteBuildArgs(args);
      const { terminalPrompts } = await import("./prompts.ts");
      await deleteBuild(
        { id, yes, configFile, bucket: deployment.lock.cloudflare.r2Bucket },
        { wrangler: (wranglerArgs) => captureWrangler(wranglerArgs, env), confirm: terminalPrompts.confirm, log: console.log, now: Date.now },
      );
      return;
    }
    case "dev":
      runWrangler(devSteps({ configFile, devVars: paths.devVars, localState: paths.localState, args: args.filter((arg) => arg !== "--") }), env);
      return;
    default:
      throw new Error("Usage: node scripts/deployment.ts deploy [--secrets] [--dry-run] | dev [-- <wrangler args>] | delete-build <build-id> [--yes] | wrangler-config");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
