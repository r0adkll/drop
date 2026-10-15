import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { githubOwnerLookup, resolveLock, type LockFile } from "./lock.ts";

// Writes ../drop.config.lock.json: the numeric ID of each Owner in ../drop.config.json (ADR 0004).
// Usage: npm run setup [-- --refresh]

const configPath = new URL("../../drop.config.json", import.meta.url);
const lockPath = new URL("../../drop.config.lock.json", import.meta.url);
const LOCK_COMMENT = "Written by `npm run setup` in server/: the numeric GitHub ID of each Owner in drop.config.json. Check it in.";

function githubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const config = JSON.parse(readFileSync(configPath, "utf8")) as { owners?: string[] };
if (!Array.isArray(config.owners)) {
  console.error("drop.config.json has no owners list.");
  process.exit(1);
}
const existing = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as LockFile) : undefined;
const refresh = process.argv.includes("--refresh");

try {
  const { lock, resolved } = await resolveLock(config.owners, existing, githubOwnerLookup(githubToken()), refresh);
  writeFileSync(lockPath, `${JSON.stringify({ $comment: LOCK_COMMENT, ...lock }, null, 2)}\n`);
  for (const owner of resolved) console.log(`Locked ${owner} as ${lock.owners[owner]}.`);
  const dropped = Object.keys(existing?.owners ?? {}).filter((owner) => !(owner in lock.owners));
  for (const owner of dropped) console.log(`Removed ${owner}, which is no longer an Owner.`);
  if (resolved.length === 0 && dropped.length === 0) console.log("drop.config.lock.json is up to date.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
