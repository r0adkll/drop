// Where a deployment's files live, for every Node script: setup, the config check, the Wrangler
// config generator and deploy (docs/design.md#deployment).
//
// A deployment repository holds drop.config.json, drop.config.lock.json and .dev.vars, and its
// `./drop` script runs these scripts from a cached checkout of Drop with DROP_DEPLOYMENT_DIR set to
// the repository. Without it, the directory is this repository's root, whose placeholder files are
// what developing Drop runs against.

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const REPOSITORY_ROOT = resolve(SERVER_DIR, "..");

export interface DeploymentPaths {
  dir: string;
  config: string;
  lock: string;
  /** The deployment's local secrets: the R2 token and the GitHub App's credentials. Never committed. */
  devVars: string;
  /** Wrangler's local state for `./drop dev`, kept with the deployment rather than the cache. */
  localState: string;
}

export function deploymentPaths(env: NodeJS.ProcessEnv = process.env): DeploymentPaths {
  const dir = resolve(env.DROP_DEPLOYMENT_DIR || REPOSITORY_ROOT);
  return {
    dir,
    config: join(dir, "drop.config.json"),
    lock: join(dir, "drop.config.lock.json"),
    devVars: join(dir, ".dev.vars"),
    localState: join(dir, ".wrangler", "state"),
  };
}

/** The generated Wrangler config a deployment builds and deploys with; gitignored. */
export const GENERATED_WRANGLER_CONFIG = join(SERVER_DIR, "wrangler.deployment.json");
