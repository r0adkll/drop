// Node-only helpers for drop.config.lock.json, used by scripts/setup.ts, scripts/check-config.ts and
// the config tests.

export interface LockFile {
  owners: Record<string, number>;
  /** The deployment's GitHub App, written by `npm run setup` once it has created it. */
  app?: { id: number; slug: string; clientId?: string };
}

/** Problems with a lockfile against the config's Owners and repository exceptions. */
export function lockErrors(config: { owners: string[]; repositories?: Record<string, unknown> }, lock: LockFile | undefined): string[] {
  if (!lock) return ["drop.config.lock.json is missing; run `npm run setup` in server/."];
  const errors: string[] = [];
  for (const owner of config.owners) {
    if (!Number.isSafeInteger(lock.owners?.[owner])) errors.push(`Owner "${owner}" has no ID in drop.config.lock.json; run \`npm run setup\` in server/.`);
  }
  for (const owner of Object.keys(lock.owners ?? {})) {
    if (!config.owners.includes(owner)) errors.push(`drop.config.lock.json lists "${owner}", which is not an Owner in drop.config.json; run \`npm run setup\` in server/.`);
  }
  if (lock.app !== undefined && (!Number.isSafeInteger(lock.app?.id) || lock.app.id <= 0 || typeof lock.app.slug !== "string" || lock.app.slug === "" || (lock.app.clientId !== undefined && typeof lock.app.clientId !== "string"))) {
    errors.push("drop.config.lock.json's app must be { id, slug, clientId } as `npm run setup` writes it.");
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
  // The App is created once and kept; resolving Owners never changes it.
  const lock: LockFile = { owners: {}, ...(existing?.app ? { app: existing.app } : {}) };
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
