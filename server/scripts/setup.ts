import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  appIsPublic, appManifest, appSecrets, convertManifestCode, pushSecrets, readDevVars, runManifestFlow, setupAccount,
  upsertDevVars, type ProcessRunner,
} from "./github-app.ts";
import { githubOwnerLookup, resolveLock, type LockFile } from "./lock.ts";

// Sets a deployment up (ADR 0004, ADR 0010):
// 1. records each Owner's numeric GitHub ID in ../drop.config.lock.json;
// 2. creates the deployment's GitHub App through GitHub's manifest flow, unless the lockfile already
//    has one, writes its secrets to .dev.vars and, if the Worker is deployed, to the Worker.
//
// Usage: npm run setup [-- --refresh] [--skip-app] [--recreate-app] [--app-name "<name>"] [--push-secrets]

const configPath = new URL("../../drop.config.json", import.meta.url);
const lockPath = new URL("../../drop.config.lock.json", import.meta.url);
const devVarsPath = new URL("../.dev.vars", import.meta.url);
const LOCK_COMMENT = "Written by `npm run setup` in server/: the numeric GitHub ID of each Owner in drop.config.json, and the deployment's GitHub App. Check it in.";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

function githubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const runProcess: ProcessRunner = (command, commandArgs, input) => {
  const result = spawnSync(command, commandArgs, { input, encoding: "utf8", cwd: new URL("..", import.meta.url) });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function openBrowser(url: string): void {
  const [command, commandArgs] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(command, commandArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

const writeLock = (lock: LockFile) => writeFileSync(lockPath, `${JSON.stringify({ $comment: LOCK_COMMENT, ...lock }, null, 2)}\n`);
const readDevVarsFile = () => (existsSync(devVarsPath) ? readFileSync(devVarsPath, "utf8") : "");

function reportPush(result: "pushed" | "not-deployed"): void {
  if (result === "pushed") {
    console.log("Stored the App's secrets on the deployed Worker.");
  } else {
    console.log("The Worker isn't deployed yet. Its first deploy carries the secrets from .dev.vars:");
    console.log("  npm run deploy:secrets");
  }
}

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { url?: string; owners?: string[] };
  if (!Array.isArray(config.owners) || typeof config.url !== "string") throw new Error("drop.config.json needs url and owners.");

  if (flag("--push-secrets")) {
    const devVars = readDevVars(readDevVarsFile());
    const secrets = Object.fromEntries(
      ["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_CLIENT_SECRET"].filter((key) => devVars[key]).map((key) => [key, devVars[key]!]),
    );
    if (Object.keys(secrets).length === 0) throw new Error(".dev.vars has no GitHub App secrets; run `npm run setup` first.");
    reportPush(pushSecrets(runProcess, secrets));
    return;
  }

  // 1. Owners.
  const token = githubToken();
  const existing = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as LockFile) : undefined;
  const { lock, resolved } = await resolveLock(config.owners, existing, githubOwnerLookup(token), flag("--refresh"));
  writeLock(lock);
  for (const owner of resolved) console.log(`Locked ${owner} as ${lock.owners[owner]}.`);
  const dropped = Object.keys(existing?.owners ?? {}).filter((owner) => !(owner in lock.owners));
  for (const owner of dropped) console.log(`Removed ${owner}, which is no longer an Owner.`);
  if (resolved.length === 0 && dropped.length === 0) console.log("Owners in drop.config.lock.json are up to date.");

  // 2. The GitHub App.
  if (flag("--skip-app")) return;
  if (lock.app && !flag("--recreate-app")) {
    console.log(`The GitHub App ${lock.app.slug} already exists. Install it from https://github.com/apps/${lock.app.slug}/installations/new`);
    return;
  }
  if (lock.app) {
    console.warn(`Creating a new App replaces ${lock.app.slug} in the lockfile. GitHub keeps the old one: delete it at https://github.com/settings/apps/${lock.app.slug}/advanced`);
  }
  if (!token) throw new Error("Creating the GitHub App needs your GitHub account: set GITHUB_TOKEN or run `gh auth login`.");

  const account = await setupAccount(token);
  const isPublic = appIsPublic(Object.values(lock.owners), account.id);
  console.log(`Creating the GitHub App under ${account.login}, as a ${isPublic ? "public App so every Owner can install it" : "private App, since you are the only Owner"}.`);
  const code = await runManifestFlow({
    buildManifest: (redirectUrl) => appManifest({ deploymentUrl: config.url!, redirectUrl, isPublic, name: option("--app-name") }),
    openBrowser,
    log: (line) => console.log(line),
  });
  const app = await convertManifestCode(code);

  writeFileSync(devVarsPath, upsertDevVars(readDevVarsFile(), appSecrets(app)));
  writeLock({ ...lock, app: { id: app.id, slug: app.slug, clientId: app.client_id } });
  console.log(`Created ${app.name} (${app.html_url}). Its ID and slug are in drop.config.lock.json; its secrets are in server/.dev.vars.`);
  reportPush(pushSecrets(runProcess, appSecrets(app)));

  const install = `https://github.com/apps/${app.slug}/installations/new`;
  console.log(`\nInstall the App on the repositories that should upload: ${install}`);
  if (isPublic) console.log("Every other Owner installs it from the same link.");
  console.log("Then commit drop.config.lock.json and deploy.");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
