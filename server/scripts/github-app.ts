// Node-only helpers that create the deployment's GitHub App through GitHub's manifest flow, used by
// scripts/setup.ts and the setup tests (ADR 0010).

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const GITHUB_API = "https://api.github.com";
const API_HEADERS = { accept: "application/vnd.github+json", "user-agent": "drop-setup", "x-github-api-version": "2022-11-28" };

/** GitHub App names are limited to 34 characters. */
export const APP_NAME_LIMIT = 34;

export interface AppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, "read" | "write">;
  default_events: string[];
}

/** "Drop <host>", trimmed to GitHub's limit. */
export function defaultAppName(deploymentUrl: string): string {
  return `Drop ${new URL(deploymentUrl).host}`.slice(0, APP_NAME_LIMIT).trimEnd();
}

/**
 * Private only when the account creating the App is the deployment's sole Owner: a private App can
 * be installed only by its owner, and every other Owner must be able to install it (ADR 0010).
 */
export function appIsPublic(lockedOwnerIds: readonly number[], setupAccountId: number): boolean {
  return !(lockedOwnerIds.length === 1 && lockedOwnerIds[0] === setupAccountId);
}

export function appManifest(options: { deploymentUrl: string; redirectUrl: string; isPublic: boolean; name?: string }): AppManifest {
  const url = options.deploymentUrl.replace(/\/+$/, "");
  return {
    name: (options.name ?? defaultAppName(url)).slice(0, APP_NAME_LIMIT),
    url,
    hook_attributes: { url: `${url}/api/v1/github/webhook`, active: true },
    redirect_url: options.redirectUrl,
    public: options.isPublic,
    // Exactly what ADR 0010 grants: Metadata read, Pull requests read and write.
    default_permissions: { metadata: "read", pull_requests: "write" },
    // Installation events reach every App without a subscription; pull_request ends Channels.
    default_events: ["pull_request"],
  };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The local page that posts the manifest to GitHub's create-App form for the signed-in user. */
export function manifestFormPage(manifest: AppManifest, state: string): string {
  const action = `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
  return `<!doctype html>
<meta charset="utf-8">
<title>Create the Drop GitHub App</title>
<body style="font: 16px system-ui, sans-serif; margin: 3rem">
<form id="manifest" method="post" action="${escapeHtml(action)}">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <p>Opening GitHub to create the App…</p>
  <button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("manifest").submit()</script>
</body>
`;
}

export const DONE_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>Drop GitHub App created</title>
<body style="font: 16px system-ui, sans-serif; margin: 3rem">
<p>The GitHub App is created. Return to your terminal to finish setup.</p>
</body>
`;

export type CallbackResult = { ok: true; code: string } | { ok: false; reason: string };

/** Checks GitHub's redirect: the state must be the one this run sent, and a code must be present. */
export function readCallback(url: URL, expectedState: string): CallbackResult {
  const state = url.searchParams.get("state");
  if (!state || state !== expectedState) return { ok: false, reason: "The redirect's state doesn't match this setup run." };
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, reason: "GitHub's redirect carried no code." };
  return { ok: true, code };
}

/** What GitHub returns when it converts a manifest code: the App and its credentials. */
export interface CreatedApp {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  owner: { login: string; id: number };
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
}

/** Exchanges the manifest flow's code for the App's credentials. The call needs no authentication. */
export async function convertManifestCode(code: string, fetchFn: typeof fetch = fetch): Promise<CreatedApp> {
  const response = await fetchFn(`${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST", headers: API_HEADERS });
  if (response.status !== 201) throw new Error(`GitHub couldn't convert the App manifest code: ${response.status} ${await response.text()}`);
  const app = (await response.json()) as CreatedApp;
  if (!Number.isSafeInteger(app.id) || !app.slug || !app.pem || !app.webhook_secret) {
    throw new Error("GitHub's manifest conversion is missing the App's ID, slug, private key or webhook secret.");
  }
  return app;
}

/** The account a token belongs to, which is where the manifest flow creates the App. */
export async function setupAccount(token: string, fetchFn: typeof fetch = fetch): Promise<{ login: string; id: number }> {
  const response = await fetchFn(`${GITHUB_API}/user`, { headers: { ...API_HEADERS, authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Couldn't identify your GitHub account: GitHub answered ${response.status}. Check GITHUB_TOKEN or \`gh auth login\`.`);
  const { login, id } = (await response.json()) as { login: string; id: number };
  return { login, id };
}

/**
 * Runs the browser half of the manifest flow on 127.0.0.1: serves the auto-submitting form, waits
 * for GitHub's redirect, and resolves with the code. GitHub allows an hour for the whole flow.
 */
export async function runManifestFlow(options: {
  buildManifest: (redirectUrl: string) => AppManifest;
  openBrowser: (url: string) => void;
  log: (line: string) => void;
  timeoutMs?: number;
}): Promise<string> {
  const state = randomBytes(24).toString("base64url");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manifest = options.buildManifest(`${origin}/callback`);

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for GitHub. Run `./drop setup` again.")), options.timeoutMs ?? 10 * 60_000);
      server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", origin);
        if (url.pathname === "/") {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(manifestFormPage(manifest, state));
          return;
        }
        if (url.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        const result = readCallback(url, state);
        if (!result.ok) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end(result.reason);
          return;
        }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE);
        clearTimeout(timer);
        resolve(result.code);
      });
      options.log(`Opening ${origin}/ to create the GitHub App. If no browser opens, visit it yourself.`);
      options.openBrowser(`${origin}/`);
    });
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Secrets

/** The Worker secrets the App's credentials become. The client secret is unused until milestone 2. */
export function appSecrets(app: CreatedApp): Record<string, string> {
  return {
    GITHUB_APP_PRIVATE_KEY: app.pem,
    GITHUB_WEBHOOK_SECRET: app.webhook_secret!,
    GITHUB_APP_CLIENT_SECRET: app.client_secret,
  };
}

/**
 * Upserts KEY="value" lines into .dev.vars text, keeping every other line. Newlines are written as
 * `\n` inside double quotes, which dotenv expands, so a PEM stays on one line.
 */
export function upsertDevVars(text: string, values: Record<string, string>): string {
  const encode = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${encode(value)}`;
    const index = lines.findIndex((existing) => existing.startsWith(`${key}=`));
    if (index === -1) lines.push(line);
    else lines[index] = line;
  }
  return `${lines.join("\n")}\n`;
}

/** Reads KEY="value" or KEY=value lines from .dev.vars text, undoing upsertDevVars's escaping. */
export function readDevVars(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const raw = match[2]!;
    values[match[1]!] = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2
      ? raw.slice(1, -1).replace(/\\(n|"|\\)/g, (_, c: string) => (c === "n" ? "\n" : c))
      : raw;
  }
  return values;
}

export interface ProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
/** Runs a command with its output captured; `env` adds to the inherited environment. */
export type ProcessRunner = (command: string, args: string[], input?: string, env?: Record<string, string>) => ProcessResult;

/**
 * Whether the deployment's Worker exists yet. Cloudflare answers 10007 (script not found) for a
 * Worker that has never been deployed.
 */
export function workerExists(run: ProcessRunner, workerName: string, env?: Record<string, string>): boolean {
  const probe = run("npx", ["--no-install", "wrangler", "secret", "list", "--name", workerName], undefined, env);
  if (probe.status === 0) return true;
  const output = `${probe.stderr}\n${probe.stdout}`;
  if (/10007|not found|does not exist/i.test(output)) return false;
  throw new Error(`wrangler secret list failed; is wrangler signed in (npx wrangler login)?\n${output.trim()}`);
}

/**
 * Puts secrets on the deployed Worker in one `wrangler secret bulk` call, reading JSON from stdin so
 * they never appear in arguments or output. Returns "not-deployed" when the Worker doesn't exist
 * yet: its first deploy then carries them with `--secrets-file` (`./drop deploy --secrets`).
 */
export function pushSecrets(run: ProcessRunner, secrets: Record<string, string>, workerName: string, env?: Record<string, string>): "pushed" | "not-deployed" {
  if (!workerExists(run, workerName, env)) return "not-deployed";
  const bulk = run("npx", ["--no-install", "wrangler", "secret", "bulk", "--name", workerName], JSON.stringify(secrets), env);
  if (bulk.status !== 0) throw new Error(`wrangler secret bulk failed:\n${bulk.stderr || bulk.stdout}`);
  return "pushed";
}
