// Node-only helpers for drop.config.lock.json, used by setup, the config check, deploy and the
// config tests.

/** The Cloudflare resources a deployment runs on, created and recorded by setup. */
export interface CloudflareLock {
  accountId: string;
  workerName: string;
  d1DatabaseId: string;
  r2Bucket: string;
}

export interface LockFile {
  owners: Record<string, number>;
  /** The deployment's GitHub App, written by setup once it has created it. */
  app?: { id: number; slug: string; clientId?: string };
  /** Filled in stage by stage as setup creates each resource; deploying needs all of it. */
  cloudflare?: Partial<CloudflareLock>;
}

/** How every message tells the operator to fix the lockfile. */
export const SETUP_HINT = "run `./drop setup` in the deployment repository";

const CLOUDFLARE_FIELDS = ["accountId", "workerName", "d1DatabaseId", "r2Bucket"] as const;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Problems with a lockfile against the config's Owners and repository exceptions. With `deploy`,
 * the Cloudflare resources must be complete too; developing Drop against the placeholders doesn't
 * need them.
 */
export function lockErrors(
  config: { owners: string[]; repositories?: Record<string, unknown> },
  lock: LockFile | undefined,
  options: { deploy?: boolean } = {},
): string[] {
  if (!lock) return [`drop.config.lock.json is missing; ${SETUP_HINT}.`];
  const errors: string[] = [];
  for (const owner of config.owners) {
    if (!Number.isSafeInteger(lock.owners?.[owner])) errors.push(`Owner "${owner}" has no ID in drop.config.lock.json; ${SETUP_HINT}.`);
  }
  for (const owner of Object.keys(lock.owners ?? {})) {
    if (!config.owners.includes(owner)) errors.push(`drop.config.lock.json lists "${owner}", which is not an Owner in drop.config.json; ${SETUP_HINT}.`);
  }
  if (lock.app !== undefined && (!Number.isSafeInteger(lock.app?.id) || lock.app.id <= 0 || typeof lock.app.slug !== "string" || lock.app.slug === "" || (lock.app.clientId !== undefined && typeof lock.app.clientId !== "string"))) {
    errors.push("drop.config.lock.json's app must be { id, slug, clientId } as setup writes it.");
  }
  const cloudflare = lock.cloudflare;
  if (cloudflare !== undefined && (typeof cloudflare !== "object" || cloudflare === null)) {
    errors.push("drop.config.lock.json's cloudflare must be { accountId, workerName, d1DatabaseId, r2Bucket } as setup writes it.");
  } else {
    for (const field of CLOUDFLARE_FIELDS) {
      const value = cloudflare?.[field];
      if (value === undefined) {
        if (options.deploy) errors.push(`drop.config.lock.json has no cloudflare.${field}; ${SETUP_HINT} before deploying.`);
      } else if (typeof value !== "string" || value === "") {
        errors.push(`drop.config.lock.json's cloudflare.${field} must be a non-empty string.`);
      }
    }
    if (typeof cloudflare?.workerName === "string" && !WORKER_NAME.test(cloudflare.workerName)) {
      errors.push(`"${cloudflare.workerName}" is not a valid Worker name: lowercase letters, digits and dashes, at most 63 characters.`);
    }
  }
  const listed = new Set(config.owners.map((owner) => owner.toLowerCase()));
  for (const repository of Object.keys(config.repositories ?? {})) {
    const owner = repository.split("/")[0]!;
    if (!listed.has(owner.toLowerCase())) errors.push(`The exception for "${repository}" has no effect: "${owner}" is not an Owner.`);
  }
  return errors;
}

/** Looks up a GitHub account's numeric ID by login. */
export type OwnerLookup = (login: string) => Promise<number>;

/**
 * The lockfile for the config's Owners. IDs already locked are kept unless `refresh` is set, so a
 * name someone else registers after a rename can't silently replace a trusted ID; Owners no longer
 * listed are dropped.
 */
export async function resolveLock(owners: string[], existing: LockFile | undefined, lookup: OwnerLookup, refresh = false): Promise<{ lock: LockFile; resolved: string[] }> {
  // The App and the Cloudflare resources are created once and kept; resolving Owners never changes them.
  const lock: LockFile = {
    owners: {},
    ...(existing?.app ? { app: existing.app } : {}),
    ...(existing?.cloudflare ? { cloudflare: existing.cloudflare } : {}),
  };
  const resolved: string[] = [];
  for (const owner of owners) {
    const locked = existing?.owners[owner];
    if (locked !== undefined && !refresh) {
      lock.owners[owner] = locked;
      continue;
    }
    lock.owners[owner] = await lookup(owner);
    resolved.push(owner);
  }
  return { lock, resolved };
}

/** Looks Owners up through GitHub's REST API, authenticated when a token is given. */
export function githubOwnerLookup(token: string | undefined, fetchFn: typeof fetch = fetch): OwnerLookup {
  return async (login) => {
    const response = await fetchFn(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "drop-setup",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (response.status === 404) throw new Error(`GitHub has no user or organization "${login}".`);
    if (!response.ok) throw new Error(`Looking up "${login}" failed: GitHub answered ${response.status} ${await response.text()}`);
    const { id } = (await response.json()) as { id: number };
    return id;
  };
}
