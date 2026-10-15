// The stages of a deployment's guided setup (docs/design.md#deployment), run by scripts/setup.ts.
// Each stage checks whether its work is already done and skips it, so setup can be run again at any
// point. Every side effect goes through SetupIO, so the stages are tested without wrangler, gh,
// GitHub or Cloudflare.

import { AwsClient } from "aws4fetch";
import {
  appIsPublic, appManifest, appSecrets, convertManifestCode, pushSecrets, runManifestFlow, setupAccount, workerExists,
  type ProcessResult, type ProcessRunner,
} from "./github-app.ts";
import { githubOwnerLookup, resolveLock, type CloudflareLock, type LockFile } from "./lock.ts";

export interface Prompts {
  ask(question: string): Promise<string>;
  /** Reads without echoing what is typed. */
  askSecret(question: string): Promise<string>;
  /** Returns the index of the chosen option. */
  choose(question: string, options: string[]): Promise<number>;
  confirm(question: string): Promise<boolean>;
  pause(message: string): Promise<void>;
}

export interface SetupIO {
  /** Runs a command with captured output, from the server directory. */
  run: ProcessRunner;
  /** Runs a command attached to the terminal (signing in, deploying) and returns its exit status. */
  runAttached(command: string, args: string[], env?: Record<string, string>): number;
  fetch: typeof fetch;
  prompts: Prompts;
  openBrowser(url: string): void;
  log(line: string): void;
  githubToken(): string | undefined;
  runManifestFlow: typeof runManifestFlow;
}

export interface SetupFiles {
  deploymentDir: string;
  devVarsPath: string;
  config: { url: string; owners: string[] };
  readLock(): LockFile | undefined;
  writeLock(lock: LockFile): void;
  readDevVars(): Record<string, string>;
  /** Upserts values into .dev.vars, keeping everything else. */
  writeDevVars(values: Record<string, string>): void;
}

export interface SetupOptions {
  refresh?: boolean;
  skipApp?: boolean;
  recreateApp?: boolean;
  appName?: string;
  workerName?: string;
}

export interface SetupContext {
  io: SetupIO;
  files: SetupFiles;
  options: SetupOptions;
  /** Set when this run wrote secrets a deployed Worker doesn't have yet. */
  secretsChanged: boolean;
  /** Work an earlier stage left for the operator, repeated at the end. */
  deferred: string[];
}

/** done: this run did the work. unchanged: it was already done. deferred: left for the operator. */
export type StageStatus = "done" | "unchanged" | "deferred";
export interface StageResult {
  status: StageStatus;
  summary: string;
}
export interface Stage {
  title: string;
  run(ctx: SetupContext): Promise<StageResult>;
}

/** Every secret setup writes to .dev.vars, which the Worker reads as secrets. */
export const WORKER_SECRETS = [
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "GITHUB_APP_CLIENT_SECRET",
] as const;

export const DEFAULT_WORKER_NAME = "drop";
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// ---------------------------------------------------------------------------------------------
// Helpers

const lockOf = (ctx: SetupContext): LockFile => ctx.files.readLock() ?? { owners: {} };

function updateCloudflare(ctx: SetupContext, patch: Partial<CloudflareLock>): Partial<CloudflareLock> {
  const lock = lockOf(ctx);
  const cloudflare = { ...lock.cloudflare, ...patch };
  ctx.files.writeLock({ ...lock, cloudflare });
  return cloudflare;
}

function cloudflareOf(ctx: SetupContext): Partial<CloudflareLock> {
  return lockOf(ctx).cloudflare ?? {};
}

/** Wrangler pinned to the deployment's account, once it is known. */
function accountEnv(ctx: SetupContext): Record<string, string> | undefined {
  const accountId = cloudflareOf(ctx).accountId;
  return accountId ? { CLOUDFLARE_ACCOUNT_ID: accountId } : undefined;
}

function wrangler(ctx: SetupContext, args: string[], input?: string): ProcessResult {
  return ctx.io.run("npx", ["--no-install", "wrangler", ...args], input, accountEnv(ctx));
}

const output = (result: ProcessResult) => `${result.stderr}\n${result.stdout}`.trim();

/** The first JSON value in a command's output, which may follow a banner line. */
export function jsonFrom(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error(`Expected JSON, got: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

function requireCloudflare<K extends keyof CloudflareLock>(ctx: SetupContext, ...keys: K[]): Pick<CloudflareLock, K> {
  const cloudflare = cloudflareOf(ctx);
  for (const key of keys) if (!cloudflare[key]) throw new Error(`drop.config.lock.json has no cloudflare.${key} yet; an earlier stage should have set it.`);
  return cloudflare as Pick<CloudflareLock, K>;
}

// ---------------------------------------------------------------------------------------------
// 1. Cloudflare account

export interface CloudflareUser {
  email?: string;
  accounts: { id: string; name: string }[];
}

/** `wrangler whoami --json`, or undefined when wrangler isn't signed in. */
export function parseWhoami(result: ProcessResult): CloudflareUser | undefined {
  if (result.status !== 0) return undefined;
  const parsed = jsonFrom(result.stdout) as { loggedIn?: boolean; email?: string; accounts?: { id: string; name: string }[] };
  if (parsed.loggedIn === false) return undefined;
  return { email: parsed.email, accounts: (parsed.accounts ?? []).map(({ id, name }) => ({ id, name })) };
}

export const cloudflareAccountStage: Stage = {
  title: "Cloudflare account",
  async run(ctx) {
    const whoami = () => parseWhoami(ctx.io.run("npx", ["--no-install", "wrangler", "whoami", "--json"]));
    let user = whoami();
    if (!user) {
      ctx.io.log("Sign in to Cloudflare in the browser window wrangler opens.");
      if (ctx.io.runAttached("npx", ["--no-install", "wrangler", "login"]) !== 0) throw new Error("`wrangler login` failed.");
      user = whoami();
      if (!user) throw new Error("wrangler still isn't signed in to Cloudflare.");
    }
    const who = user.email ?? "this login";

    const locked = cloudflareOf(ctx);
    if (ctx.options.workerName && locked.workerName && ctx.options.workerName !== locked.workerName) {
      throw new Error(`This deployment's Worker is already "${locked.workerName}" in drop.config.lock.json; --worker-name can't change it.`);
    }
    const workerName = locked.workerName ?? ctx.options.workerName ?? DEFAULT_WORKER_NAME;
    if (!WORKER_NAME.test(workerName)) throw new Error(`"${workerName}" is not a valid Worker name: lowercase letters, digits and dashes.`);

    if (locked.accountId) {
      const account = user.accounts.find((candidate) => candidate.id === locked.accountId);
      if (!account) {
        throw new Error(`This deployment runs on Cloudflare account ${locked.accountId}, which ${who} can't reach. Sign in as the right user with \`npx wrangler login\`.`);
      }
      if (!locked.workerName) updateCloudflare(ctx, { workerName });
      return { status: "unchanged", summary: `Signed in as ${who}; the deployment runs on ${account.name} as the Worker "${workerName}".` };
    }

    if (user.accounts.length === 0) throw new Error(`${who} has no Cloudflare accounts wrangler can use.`);
    const index = user.accounts.length === 1
      ? 0
      : await ctx.io.prompts.choose("Which Cloudflare account should Drop run on?", user.accounts.map((account) => `${account.name} (${account.id})`));
    const account = user.accounts[index]!;
    updateCloudflare(ctx, { accountId: account.id, workerName });
    return { status: "done", summary: `Drop will run on ${account.name} as the Worker "${workerName}".` };
  },
};

// ---------------------------------------------------------------------------------------------
// 2. D1 database

function listDatabases(ctx: SetupContext): { id: string; name: string }[] {
  const result = wrangler(ctx, ["d1", "list", "--json"]);
  if (result.status !== 0) throw new Error(`wrangler d1 list failed:\n${output(result)}`);
  return (jsonFrom(result.stdout) as { uuid?: string; id?: string; name: string }[]).map((database) => ({ id: database.uuid ?? database.id ?? "", name: database.name }));
}

export const databaseStage: Stage = {
  title: "D1 database",
  async run(ctx) {
    const { workerName } = requireCloudflare(ctx, "workerName");
    const locked = cloudflareOf(ctx).d1DatabaseId;
    let databases = listDatabases(ctx);
    if (locked && databases.some((database) => database.id === locked)) {
      return { status: "unchanged", summary: `The D1 database ${workerName} exists.` };
    }
    if (locked) ctx.io.log(`The locked database ${locked} no longer exists; looking for one named ${workerName}.`);

    let database = databases.find((candidate) => candidate.name === workerName);
    if (database) {
      updateCloudflare(ctx, { d1DatabaseId: database.id });
      return { status: "done", summary: `Using the existing D1 database ${workerName}.` };
    }
    const created = wrangler(ctx, ["d1", "create", workerName]);
    if (created.status !== 0) throw new Error(`wrangler d1 create failed:\n${output(created)}`);
    databases = listDatabases(ctx);
    database = databases.find((candidate) => candidate.name === workerName);
    if (!database) throw new Error(`Created the D1 database ${workerName}, but \`wrangler d1 list\` doesn't show it.`);
    updateCloudflare(ctx, { d1DatabaseId: database.id });
    return { status: "done", summary: `Created the D1 database ${workerName}.` };
  },
};

// ---------------------------------------------------------------------------------------------
// 3. R2 bucket and token

/**
 * Whether R2 S3 credentials can list the bucket, the narrowest call an "Object Read & Write" token
 * scoped to one bucket is allowed.
 */
export async function r2CredentialsWork(
  fetchFn: typeof fetch,
  options: { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string },
): Promise<boolean> {
  const client = new AwsClient({ accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, service: "s3", region: "auto" });
  const url = `https://${options.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(options.bucket)}?list-type=2&max-keys=1`;
  const response = await fetchFn(await client.sign(url, { method: "GET" }));
  return response.ok;
}

/** Creates the bucket unless it exists; true when this run created it. */
async function ensureBucket(ctx: SetupContext, bucket: string, accountId: string): Promise<boolean> {
  if (wrangler(ctx, ["r2", "bucket", "info", bucket]).status === 0) return false;
  for (let attempt = 0; ; attempt++) {
    const created = wrangler(ctx, ["r2", "bucket", "create", bucket]);
    if (created.status === 0) return true;
    // Until R2 is enabled for the account, which only the dashboard can do, creating a bucket fails
    // with code 10042.
    if (attempt === 0 && /10042|enable R2/i.test(output(created))) {
      ctx.io.log("R2 isn't enabled on this account yet. Enable it in the dashboard (the free tier needs a payment method on file).");
      ctx.io.openBrowser(`https://dash.cloudflare.com/${accountId}/r2/overview`);
      await ctx.io.prompts.pause("Press Enter once R2 is enabled.");
      continue;
    }
    throw new Error(`wrangler r2 bucket create failed:\n${output(created)}`);
  }
}

export const storageStage: Stage = {
  title: "R2 bucket and API token",
  async run(ctx) {
    const { accountId, workerName } = requireCloudflare(ctx, "accountId", "workerName");
    const bucket = cloudflareOf(ctx).r2Bucket ?? `${workerName}-builds`;
    const created = await ensureBucket(ctx, bucket, accountId);
    if (cloudflareOf(ctx).r2Bucket !== bucket) updateCloudflare(ctx, { r2Bucket: bucket });

    const vars = ctx.files.readDevVars();
    const saved = vars.R2_ACCOUNT_ID === accountId && vars.R2_ACCESS_KEY_ID && vars.R2_SECRET_ACCESS_KEY
      ? { accessKeyId: vars.R2_ACCESS_KEY_ID, secretAccessKey: vars.R2_SECRET_ACCESS_KEY }
      : undefined;
    if (saved && (await r2CredentialsWork(ctx.io.fetch, { accountId, bucket, ...saved }))) {
      return { status: created ? "done" : "unchanged", summary: `${created ? "Created" : "Using"} the R2 bucket ${bucket}; its API token in .dev.vars works.` };
    }

    ctx.io.log("The Worker signs upload URLs with an R2 API token limited to this bucket. Create one:");
    ctx.io.openBrowser(`https://dash.cloudflare.com/${accountId}/r2/api-tokens`);
    ctx.io.log("  1. Create an Account API token (or a User API token) named drop-uploads.");
    ctx.io.log("  2. Permissions: Object Read & Write.");
    ctx.io.log(`  3. Specify bucket(s): Apply to specific buckets only, then ${bucket}.`);
    ctx.io.log("  4. Create the token. The next page shows its S3 credentials once.");
    for (let attempt = 0; attempt < 3; attempt++) {
      const accessKeyId = (await ctx.io.prompts.ask("Access Key ID:")).trim();
      const secretAccessKey = (await ctx.io.prompts.askSecret("Secret Access Key (hidden):")).trim();
      if (await r2CredentialsWork(ctx.io.fetch, { accountId, bucket, accessKeyId, secretAccessKey })) {
        ctx.files.writeDevVars({ R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey });
        ctx.secretsChanged = true;
        return { status: "done", summary: `${created ? "Created" : "Using"} the R2 bucket ${bucket}; its API token is in .dev.vars.` };
      }
      ctx.io.log(`Those credentials can't list ${bucket}. Check the token has Object Read & Write on that bucket, and try again.`);
    }
    throw new Error("No working R2 API token after three tries.");
  },
};

// ---------------------------------------------------------------------------------------------
// 4. Owners

export const ownersStage: Stage = {
  title: "Owners",
  async run(ctx) {
    const existing = ctx.files.readLock();
    const { lock, resolved } = await resolveLock(ctx.files.config.owners, existing, githubOwnerLookup(ctx.io.githubToken(), ctx.io.fetch), ctx.options.refresh);
    ctx.files.writeLock(lock);
    const dropped = Object.keys(existing?.owners ?? {}).filter((owner) => !(owner in lock.owners));
    if (resolved.length === 0 && dropped.length === 0) return { status: "unchanged", summary: "Every Owner's ID is locked." };
    const parts = [
      ...resolved.map((owner) => `locked ${owner} as ${lock.owners[owner]}`),
      ...dropped.map((owner) => `removed ${owner}, which is no longer an Owner`),
    ];
    return { status: "done", summary: `${parts.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()) };
  },
};

// ---------------------------------------------------------------------------------------------
// 5. GitHub App

export const appStage: Stage = {
  title: "GitHub App",
  async run(ctx) {
    const lock = lockOf(ctx);
    if (ctx.options.skipApp) {
      ctx.deferred.push("Create the GitHub App: run `./drop setup` without --skip-app.");
      return { status: "deferred", summary: "Skipped (--skip-app). The Worker can't deploy without the App's secrets." };
    }
    if (lock.app && !ctx.options.recreateApp) return { status: "unchanged", summary: `The GitHub App ${lock.app.slug} exists.` };
    if (lock.app) {
      ctx.io.log(`Creating a new App replaces ${lock.app.slug} in the lockfile. GitHub keeps the old one: delete it at https://github.com/settings/apps/${lock.app.slug}/advanced`);
    }
    const token = ctx.io.githubToken();
    if (!token) throw new Error("Creating the GitHub App needs your GitHub account: set GITHUB_TOKEN or run `gh auth login`.");

    const account = await setupAccount(token, ctx.io.fetch);
    const isPublic = appIsPublic(Object.values(lock.owners), account.id);
    ctx.io.log(`Creating the GitHub App under ${account.login}, as a ${isPublic ? "public App so every Owner can install it" : "private App, since you are the only Owner"}.`);
    const code = await ctx.io.runManifestFlow({
      buildManifest: (redirectUrl) => appManifest({ deploymentUrl: ctx.files.config.url, redirectUrl, isPublic, name: ctx.options.appName }),
      openBrowser: ctx.io.openBrowser,
      log: ctx.io.log,
    });
    const app = await convertManifestCode(code, ctx.io.fetch);
    ctx.files.writeDevVars(appSecrets(app));
    ctx.files.writeLock({ ...lockOf(ctx), app: { id: app.id, slug: app.slug, clientId: app.client_id } });
    ctx.secretsChanged = true;
    return { status: "done", summary: `Created ${app.name} (${app.html_url}); its secrets are in .dev.vars.` };
  },
};

// ---------------------------------------------------------------------------------------------
// 6. First deploy

export const firstDeployStage: Stage = {
  title: "First deploy",
  async run(ctx) {
    const { workerName } = requireCloudflare(ctx, "workerName");
    const url = ctx.files.config.url;
    const env = accountEnv(ctx);
    if (workerExists(ctx.io.run, workerName, env)) {
      if (!ctx.secretsChanged) return { status: "unchanged", summary: `${workerName} is deployed. Later deploys run in CI when you push, or with \`./drop deploy\`.` };
      const vars = ctx.files.readDevVars();
      const secrets = Object.fromEntries(WORKER_SECRETS.filter((key) => vars[key]).map((key) => [key, vars[key]!]));
      pushSecrets(ctx.io.run, secrets, workerName, env);
      return { status: "done", summary: `Stored the new secrets on the deployed Worker ${workerName}.` };
    }

    const host = new URL(url).host;
    if (host.endsWith(".workers.dev")) {
      ctx.io.log(`${host} is a workers.dev URL: it works once the account's workers.dev subdomain matches it.`);
    } else {
      ctx.io.log(`The Worker answers on ${host} as a Custom Domain. Its zone must be active on this Cloudflare account,`);
      ctx.io.log(`and ${host} must not already have a CNAME record; Cloudflare creates the DNS record and certificate.`);
    }
    ctx.io.log("The first deploy uploads the secrets in .dev.vars with it.");
    if (!(await ctx.io.prompts.confirm(`Deploy ${workerName} to ${url} now?`))) {
      ctx.deferred.push("Deploy the Worker the first time: `./drop deploy --secrets`.");
      return { status: "deferred", summary: "Not deployed yet." };
    }
    const status = ctx.io.runAttached("node", ["scripts/deployment.ts", "deploy", "--secrets"], { DROP_DEPLOYMENT_DIR: ctx.files.deploymentDir });
    if (status !== 0) throw new Error("The first deploy failed; fix the error above and run `./drop setup` again.");
    return { status: "done", summary: `Deployed ${workerName} to ${url}.` };
  },
};

// ---------------------------------------------------------------------------------------------
// 7. CI credentials

/** owner/name of a GitHub remote URL, in any of the forms git prints. */
export function githubRepositoryOf(remoteUrl: string): string | undefined {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

/** Whether a Cloudflare API token is active, as a user-owned or an account-owned token. */
export async function cloudflareTokenWorks(fetchFn: typeof fetch, token: string, accountId: string): Promise<boolean> {
  for (const path of ["/user/tokens/verify", `/accounts/${accountId}/tokens/verify`]) {
    const response = await fetchFn(`https://api.cloudflare.com/client/v4${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) continue;
    const body = (await response.json()) as { success?: boolean; result?: { status?: string } };
    if (body.success && body.result?.status === "active") return true;
  }
  return false;
}

function tokenSteps(ctx: SetupContext, accountId: string): void {
  const host = new URL(ctx.files.config.url).host;
  ctx.io.log("CI deploys with a Cloudflare API token. Create one:");
  ctx.io.openBrowser("https://dash.cloudflare.com/profile/api-tokens");
  ctx.io.log("  1. Create Token, then Use template next to Edit Cloudflare Workers.");
  ctx.io.log("  2. Add a permission: Account, D1, Edit (migrations run on every deploy).");
  ctx.io.log(`  3. Account Resources: Include, then the account ${accountId}.`);
  ctx.io.log(`  4. Zone Resources: Include, Specific zone, then the zone of ${host}.`);
  ctx.io.log("  5. Continue to summary, Create Token, and copy it.");
}

export const ciStage: Stage = {
  title: "CI credentials",
  async run(ctx) {
    const { accountId } = requireCloudflare(ctx, "accountId");
    const remote = ctx.io.run("git", ["-C", ctx.files.deploymentDir, "remote", "get-url", "origin"]);
    const repository = remote.status === 0 ? githubRepositoryOf(remote.stdout) : undefined;
    const ghReady = repository !== undefined && ctx.io.run("gh", ["auth", "status"]).status === 0;
    if (!repository || !ghReady) {
      tokenSteps(ctx, accountId);
      ctx.io.log("Then add both to the deployment repository's Actions settings, or with gh:");
      ctx.io.log("  gh secret set CLOUDFLARE_API_TOKEN        (paste the token when asked)");
      ctx.io.log(`  gh variable set CLOUDFLARE_ACCOUNT_ID --body ${accountId}`);
      ctx.deferred.push(`Add the CLOUDFLARE_API_TOKEN secret and CLOUDFLARE_ACCOUNT_ID variable (${accountId}) to the deployment repository.`);
      return { status: "deferred", summary: repository ? "gh isn't signed in, so the CI credentials are left to you." : "The deployment repository has no GitHub remote yet, so the CI credentials are left to you." };
    }

    const gh = (args: string[], input?: string) => ctx.io.run("gh", [...args, "--repo", repository], input);
    const secrets = gh(["secret", "list", "--json", "name"]);
    const variables = gh(["variable", "list", "--json", "name,value"]);
    if (secrets.status !== 0 || variables.status !== 0) throw new Error(`gh can't read ${repository}'s Actions settings:\n${output(secrets.status !== 0 ? secrets : variables)}`);
    const hasToken = (jsonFrom(secrets.stdout) as { name: string }[]).some((secret) => secret.name === "CLOUDFLARE_API_TOKEN");
    const accountVariable = (jsonFrom(variables.stdout) as { name: string; value: string }[]).find((variable) => variable.name === "CLOUDFLARE_ACCOUNT_ID");
    if (hasToken && accountVariable?.value === accountId) return { status: "unchanged", summary: `${repository} has its Cloudflare token and account ID.` };

    if (accountVariable?.value !== accountId) {
      const set = gh(["variable", "set", "CLOUDFLARE_ACCOUNT_ID", "--body", accountId]);
      if (set.status !== 0) throw new Error(`gh variable set failed:\n${output(set)}`);
    }
    if (!hasToken) {
      tokenSteps(ctx, accountId);
      for (let attempt = 0; ; attempt++) {
        const token = (await ctx.io.prompts.askSecret("Cloudflare API token (hidden):")).trim();
        if (await cloudflareTokenWorks(ctx.io.fetch, token, accountId)) {
          const set = gh(["secret", "set", "CLOUDFLARE_API_TOKEN"], token);
          if (set.status !== 0) throw new Error(`gh secret set failed:\n${output(set)}`);
          break;
        }
        if (attempt === 2) throw new Error("Cloudflare didn't accept that token after three tries.");
        ctx.io.log("Cloudflare doesn't report that token as active. Copy it again and paste it.");
      }
    }
    return { status: "done", summary: `Stored the Cloudflare token and account ID in ${repository}'s Actions settings.` };
  },
};

// ---------------------------------------------------------------------------------------------
// 8. Finish

export const finishStage: Stage = {
  title: "Finish",
  async run(ctx) {
    const lock = lockOf(ctx);
    if (lock.app) {
      ctx.io.log(`Install the GitHub App on the repositories that should upload: https://github.com/apps/${lock.app.slug}/installations/new`);
      if (Object.keys(lock.owners).length > 1) ctx.io.log("Every other Owner installs it from the same link.");
    }
    ctx.io.log("Commit drop.config.json and drop.config.lock.json, and push: the deploy workflow deploys every push to main.");
    for (const item of ctx.deferred) ctx.io.log(`Still to do: ${item}`);
    return { status: ctx.deferred.length > 0 ? "deferred" : "done", summary: ctx.deferred.length > 0 ? `${ctx.deferred.length} step(s) left for you, listed above.` : "Setup is complete." };
  },
};

export const STAGES: Stage[] = [cloudflareAccountStage, databaseStage, storageStage, ownersStage, appStage, firstDeployStage, ciStage, finishStage];

/** Runs every stage in order, announcing each with its position, and stops at the first failure. */
export async function runSetup(ctx: SetupContext, stages: Stage[] = STAGES): Promise<StageResult[]> {
  const results: StageResult[] = [];
  for (const [index, stage] of stages.entries()) {
    ctx.io.log(`\n▸ Stage ${index + 1}/${stages.length} · ${stage.title}`);
    let result: StageResult;
    try {
      result = await stage.run(ctx);
    } catch (error) {
      throw new Error(`${stage.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
    ctx.io.log(`  ${result.status === "deferred" ? "→" : "✓"} ${result.summary}`);
    results.push(result);
  }
  return results;
}
