// Generates the Wrangler config a deployment builds and deploys with, from the committed
// wrangler.jsonc, the deployment's lockfile and its URL (docs/design.md#deployment). Pure, so it is
// tested without wrangler.

import type { CloudflareLock } from "./lock.ts";

/** The parts of a Wrangler config this generator reads or writes; everything else passes through. */
export interface WranglerConfig {
  $schema?: string;
  name?: string;
  account_id?: string;
  alias?: Record<string, string>;
  d1_databases?: { binding: string; database_name?: string; database_id?: string; [key: string]: unknown }[];
  r2_buckets?: { binding: string; bucket_name?: string; [key: string]: unknown }[];
  vars?: Record<string, unknown>;
  routes?: { pattern: string; custom_domain?: boolean }[];
  workers_dev?: boolean;
  preview_urls?: boolean;
  [key: string]: unknown;
}

export interface DeploymentInput {
  /** drop.config.json's url: the hostname Build pages, webhooks and upload tokens use. */
  url: string;
  cloudflare: CloudflareLock;
  /** Absolute paths the Worker bundles as its config and lockfile. */
  configPath: string;
  lockPath: string;
}

/** The bundler aliases src/config.ts imports the deployment's files through. */
export const CONFIG_ALIAS = "drop-deployment/config";
export const LOCK_ALIAS = "drop-deployment/lock";

const WORKERS_DEV = ".workers.dev";

export function deploymentWranglerConfig(base: WranglerConfig, input: DeploymentInput): WranglerConfig {
  const { cloudflare } = input;
  const host = new URL(input.url).host;
  const { $schema: _schema, ...rest } = base;

  const d1 = (base.d1_databases ?? []).map((database) =>
    database.binding === "DB" ? { ...database, database_name: cloudflare.workerName, database_id: cloudflare.d1DatabaseId } : database,
  );
  if (!d1.some((database) => database.binding === "DB")) throw new Error("wrangler.jsonc has no D1 database bound as DB.");
  const r2 = (base.r2_buckets ?? []).map((bucket) => (bucket.binding === "BUILDS" ? { ...bucket, bucket_name: cloudflare.r2Bucket } : bucket));
  if (!r2.some((bucket) => bucket.binding === "BUILDS")) throw new Error("wrangler.jsonc has no R2 bucket bound as BUILDS.");

  const generated: WranglerConfig = {
    ...rest,
    name: cloudflare.workerName,
    account_id: cloudflare.accountId,
    alias: { ...base.alias, [CONFIG_ALIAS]: input.configPath, [LOCK_ALIAS]: input.lockPath },
    d1_databases: d1,
    r2_buckets: r2,
    // Presigned upload URLs address the bucket by name.
    vars: { ...base.vars, R2_BUCKET_NAME: cloudflare.r2Bucket },
  };

  if (host.endsWith(WORKERS_DEV)) {
    // <worker>.<account subdomain>.workers.dev only reaches the Worker of that name.
    const worker = host.slice(0, host.indexOf("."));
    if (worker !== cloudflare.workerName) {
      throw new Error(`${input.url} is a workers.dev URL for a Worker named "${worker}", but this deployment's Worker is "${cloudflare.workerName}".`);
    }
    return { ...generated, workers_dev: true, routes: undefined };
  }
  // One canonical URL: it is the upload tokens' audience, so the workers.dev and preview URLs stay off.
  return { ...generated, routes: [{ pattern: host, custom_domain: true }], workers_dev: false, preview_urls: false };
}

/**
 * Parses JSON with comments and trailing commas, as wrangler.jsonc is written. Comment markers inside
 * strings are left alone.
 */
export function parseJsonc(text: string): unknown {
  return JSON.parse(outsideStrings(outsideStrings(text, stripComment), stripTrailingComma));
}

/** Rewrites text outside JSON strings: `step` consumes from `i` and returns what to keep and where to resume. */
function outsideStrings(text: string, step: (text: string, i: number) => [string, number]): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
    } else {
      const [kept, next] = step(text, i);
      out += kept;
      i = next;
    }
  }
  return out;
}

function stripComment(text: string, i: number): [string, number] {
  if (text.startsWith("//", i)) {
    const end = text.indexOf("\n", i);
    return ["", end === -1 ? text.length : end];
  }
  if (text.startsWith("/*", i)) {
    const end = text.indexOf("*/", i + 2);
    return ["", end === -1 ? text.length : end + 2];
  }
  return [text[i]!, i + 1];
}

function stripTrailingComma(text: string, i: number): [string, number] {
  if (text[i] === ",") {
    let next = i + 1;
    while (next < text.length && /\s/.test(text[next]!)) next++;
    if (text[next] === "}" || text[next] === "]") return ["", i + 1];
  }
  return [text[i]!, i + 1];
}
