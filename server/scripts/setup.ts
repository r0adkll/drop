import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pushSecrets, readDevVars, runManifestFlow, upsertDevVars, type ProcessRunner } from "./github-app.ts";
import type { LockFile } from "./lock.ts";
import { deploymentPaths, SERVER_DIR } from "./paths.ts";
import { terminalPrompts } from "./prompts.ts";
import { runSetup, WORKER_SECRETS, type SetupContext, type SetupFiles } from "./setup-stages.ts";

// Sets a deployment up, stage by stage (docs/design.md#deployment, ADR 0004, ADR 0010): the
// Cloudflare account, D1 database, R2 bucket and token, Owner IDs, the GitHub App, the first deploy
// and CI's credentials. Every stage skips work that is already done, so it is safe to run again.
// A deployment repository runs it as `./drop setup`, which sets DROP_DEPLOYMENT_DIR.
//
// Usage: ./drop setup [--refresh] [--skip-app] [--recreate-app] [--app-name "<name>"]
//                     [--worker-name <name>] [--push-secrets]

const LOCK_COMMENT = "Written by `./drop setup`: the numeric GitHub ID of each Owner in drop.config.json, the deployment's GitHub App and its Cloudflare resources. Check it in.";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const paths = deploymentPaths();

function githubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const run: ProcessRunner = (command, commandArgs, input, env) => {
  const result = spawnSync(command, commandArgs, { input, encoding: "utf8", cwd: SERVER_DIR, env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function runAttached(command: string, commandArgs: string[], env?: Record<string, string>): number {
  return spawnSync(command, commandArgs, { stdio: "inherit", cwd: SERVER_DIR, env: { ...process.env, ...env } }).status ?? 1;
}

function openBrowser(url: string): void {
  const [command, commandArgs] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(command, commandArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  console.log(`  ↗ ${url}`);
}

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "");

function files(): SetupFiles {
  if (!existsSync(paths.config)) throw new Error(`${paths.config} doesn't exist. Run setup from a deployment repository (\`./drop setup\`).`);
  const config = JSON.parse(readFileSync(paths.config, "utf8")) as { url?: string; owners?: string[] };
  if (!Array.isArray(config.owners) || typeof config.url !== "string") throw new Error("drop.config.json needs url and owners.");
  return {
    deploymentDir: paths.dir,
    devVarsPath: paths.devVars,
    config: { url: config.url, owners: config.owners },
    readLock: () => (existsSync(paths.lock) ? (JSON.parse(readFileSync(paths.lock, "utf8")) as LockFile) : undefined),
    writeLock: (lock) => {
      const { $comment: _comment, ...rest } = lock as LockFile & { $comment?: string };
      writeFileSync(paths.lock, `${JSON.stringify({ $comment: LOCK_COMMENT, ...rest }, null, 2)}\n`);
    },
    readDevVars: () => readDevVars(readText(paths.devVars)),
    writeDevVars: (values) => writeFileSync(paths.devVars, upsertDevVars(readText(paths.devVars), values)),
  };
}

async function main(): Promise<void> {
  const setupFiles = files();

  if (flag("--push-secrets")) {
    const workerName = setupFiles.readLock()?.cloudflare?.workerName;
    if (!workerName) throw new Error("drop.config.lock.json has no Worker yet; run `./drop setup` first.");
    const vars = setupFiles.readDevVars();
    const secrets = Object.fromEntries(WORKER_SECRETS.filter((key) => vars[key]).map((key) => [key, vars[key]!]));
    if (Object.keys(secrets).length === 0) throw new Error(".dev.vars has no secrets; run `./drop setup` first.");
    const accountId = setupFiles.readLock()?.cloudflare?.accountId;
    const result = pushSecrets(run, secrets, workerName, accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : undefined);
    console.log(result === "pushed" ? `Stored ${Object.keys(secrets).length} secrets on ${workerName}.` : `${workerName} isn't deployed yet; deploy it the first time with \`./drop deploy --secrets\`.`);
    return;
  }

  const ctx: SetupContext = {
    io: { run, runAttached, fetch, prompts: terminalPrompts, openBrowser, log: (line) => console.log(line), githubToken, runManifestFlow },
    files: setupFiles,
    options: {
      refresh: flag("--refresh"),
      skipApp: flag("--skip-app"),
      recreateApp: flag("--recreate-app"),
      appName: option("--app-name"),
      workerName: option("--worker-name"),
    },
    secretsChanged: false,
    deferred: [],
  };
  console.log(`Setting up the Drop deployment in ${paths.dir}`);
  await runSetup(ctx);
}

try {
  await main();
} catch (error) {
  console.error(`\n✘ ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
