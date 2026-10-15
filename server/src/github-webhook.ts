// The GitHub App's webhooks, as far as Drop's allow-list needs them: which repositories each listed
// Owner's installation covers (ADR 0004).
//
// Webhooks keep D1 current between resyncs. A missed delivery, or a switch from all repositories to
// selected ones (which reports only the repositories removed), is repaired by the installation
// resync in github/installations.ts.

import type { CommentTarget } from "./github/pull-request-comment";

export interface WebhookAccount {
  id: number;
  login: string;
}

export interface WebhookInstallation {
  id: number;
  account: WebhookAccount;
  repository_selection: "all" | "selected";
  suspended_at?: string | null;
}

export interface WebhookRepository {
  id: number;
  full_name: string;
}

export type WebhookOutcome = "applied" | "ignored";

/**
 * Whether `header` (`sha256=<hex>`) is the HMAC-SHA256 of `body` under `secret`. WebCrypto's verify
 * compares in constant time.
 */
export async function verifyWebhookSignature(secret: string, body: ArrayBuffer, header: string | undefined): Promise<boolean> {
  const hex = header?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
  if (!hex || !secret) return false;
  const signature = new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, body);
}

export class WebhookPayloadError extends Error {}

/**
 * Applies an `installation` or `installation_repositories` event from a listed Owner, by locked ID.
 * Everything else, including installations by other accounts, is ignored.
 */
export async function handleWebhook(
  db: D1Database,
  owners: Record<string, number>,
  event: string,
  payload: unknown,
  now: number,
): Promise<WebhookOutcome> {
  if (event !== "installation" && event !== "installation_repositories") return "ignored";
  const body = payload as { action?: string; installation?: WebhookInstallation };
  const installation = body.installation;
  if (typeof body.action !== "string" || !isInstallation(installation)) {
    throw new WebhookPayloadError(`The ${event} event has no installation.`);
  }
  if (!isListedOwner(owners, installation.account)) return "ignored";

  if (event === "installation") {
    const repositories = (payload as { repositories?: WebhookRepository[] }).repositories ?? [];
    switch (body.action) {
      case "created":
        await db.batch([
          ...upsertInstallation(db, installation, installation.repository_selection, now),
          db.prepare("DELETE FROM installation_repositories WHERE installation_id = ?").bind(installation.id),
          ...repositories.map((repository) => addRepository(db, installation.id, repository)),
        ]);
        return "applied";
      case "deleted":
        await db.batch([
          db.prepare("DELETE FROM installation_repositories WHERE installation_id = ?").bind(installation.id),
          db.prepare("DELETE FROM installations WHERE id = ?").bind(installation.id),
        ]);
        return "applied";
      case "suspend":
      case "unsuspend":
        // The payload's suspended_at carries the new state either way.
        await db.batch(upsertInstallation(db, installation, installation.repository_selection, now));
        return "applied";
      default:
        // new_permissions_accepted and anything newer change nothing Drop records.
        return "ignored";
    }
  }

  const change = payload as {
    repository_selection?: "all" | "selected";
    repositories_added?: WebhookRepository[];
    repositories_removed?: WebhookRepository[];
  };
  if (body.action !== "added" && body.action !== "removed") return "ignored";
  await db.batch([
    ...upsertInstallation(db, installation, change.repository_selection ?? installation.repository_selection, now),
    ...(change.repositories_added ?? []).map((repository) => addRepository(db, installation.id, repository)),
    ...(change.repositories_removed ?? []).map((repository) =>
      db.prepare("DELETE FROM installation_repositories WHERE installation_id = ? AND repository_id = ?").bind(installation.id, repository.id),
    ),
  ]);
  return "applied";
}

export function isInstallation(value: unknown): value is WebhookInstallation {
  const installation = value as WebhookInstallation | undefined;
  return (
    typeof installation?.id === "number" &&
    typeof installation.account?.id === "number" &&
    typeof installation.account.login === "string" &&
    (installation.repository_selection === "all" || installation.repository_selection === "selected")
  );
}

/** By locked ID only. A listed login with another ID is someone else using that name. */
export function isListedOwner(owners: Record<string, number>, account: WebhookAccount): boolean {
  if (Object.values(owners).includes(account.id)) return true;
  const sameName = Object.entries(owners).find(([login]) => login.toLowerCase() === account.login.toLowerCase());
  if (sameName) {
    console.warn(
      `Ignoring the GitHub App installation by ${account.login} (ID ${account.id}): drop.config.lock.json locks ${sameName[0]} as ID ${sameName[1]}.`,
    );
  }
  return false;
}

/** Records an installation, replacing any earlier one by the same account whose deletion was missed. */
export function upsertInstallation(db: D1Database, installation: WebhookInstallation, selection: "all" | "selected", now: number): D1PreparedStatement[] {
  const suspendedAt = installation.suspended_at ? Date.parse(installation.suspended_at) || now : null;
  return [
    db
      .prepare("DELETE FROM installation_repositories WHERE installation_id IN (SELECT id FROM installations WHERE account_id = ? AND id != ?)")
      .bind(installation.account.id, installation.id),
    db.prepare("DELETE FROM installations WHERE account_id = ? AND id != ?").bind(installation.account.id, installation.id),
    db
      .prepare(
        `INSERT INTO installations (id, account_id, account_login, repository_selection, suspended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET account_login = excluded.account_login,
           repository_selection = excluded.repository_selection, suspended_at = excluded.suspended_at,
           updated_at = excluded.updated_at`,
      )
      .bind(installation.id, installation.account.id, installation.account.login, selection, suspendedAt, now, now),
  ];
}

export function addRepository(db: D1Database, installationId: number, repository: WebhookRepository): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO installation_repositories (installation_id, repository_id, full_name) VALUES (?, ?, ?)
       ON CONFLICT (installation_id, repository_id) DO UPDATE SET full_name = excluded.full_name`,
    )
    .bind(installationId, repository.id, repository.full_name);
}

export interface PullRequestEventResult {
  outcome: WebhookOutcome;
  /** The comment to bring up to date, when the event changed what it says. */
  comment?: CommentTarget;
}

/**
 * A `pull_request` event. Closing one, merged or not, ends its Pull request channels, which the
 * comment then notes (docs/design.md#channels).
 */
export async function handlePullRequestEvent(db: D1Database, owners: Record<string, number>, payload: unknown, now: number): Promise<PullRequestEventResult> {
  const body = payload as {
    action?: string;
    number?: number;
    pull_request?: { merged?: boolean; closed_at?: string | null };
    repository?: { id?: number; full_name?: string; owner?: WebhookAccount };
    installation?: { id?: number };
  };
  const { repository, installation } = body;
  if (
    typeof body.action !== "string" ||
    !Number.isInteger(body.number) ||
    typeof repository?.id !== "number" ||
    typeof repository.full_name !== "string" ||
    typeof repository.owner?.id !== "number" ||
    typeof repository.owner.login !== "string" ||
    typeof installation?.id !== "number"
  ) {
    throw new WebhookPayloadError("The pull_request event is missing its number, repository or installation.");
  }
  // TODO: `reopened` is ignored: design.md ends a Channel on close, so a reopened pull request's
  // uploads are refused with channel_ended until reopening is designed.
  if (body.action !== "closed") return { outcome: "ignored" };
  if (!isListedOwner(owners, repository.owner)) return { outcome: "ignored" };

  const pullRequest = body.number!;
  const channels = await db
    .prepare("SELECT COUNT(*) AS n FROM channels WHERE pull_request = ? AND application_id IN (SELECT application_id FROM products WHERE repository_id = ?)")
    .bind(pullRequest, repository.id)
    .first<{ n: number }>();
  if (!channels?.n) return { outcome: "ignored" };

  const closedAt = (body.pull_request?.closed_at && Date.parse(body.pull_request.closed_at)) || now;
  const merged = body.pull_request?.merged === true ? 1 : 0;
  await db.batch([
    db
      .prepare(
        `UPDATE channels SET ended_at = ? WHERE pull_request = ? AND ended_at IS NULL
         AND application_id IN (SELECT application_id FROM products WHERE repository_id = ?)`,
      )
      .bind(closedAt, pullRequest, repository.id),
    db
      .prepare(
        `INSERT INTO pull_request_comments (repository_id, pull_request, closed_at, merged) VALUES (?, ?, ?, ?)
         ON CONFLICT (repository_id, pull_request) DO UPDATE SET closed_at = excluded.closed_at, merged = excluded.merged`,
      )
      .bind(repository.id, pullRequest, closedAt, merged),
  ]);
  return {
    outcome: "applied",
    comment: { repositoryId: repository.id, repository: repository.full_name, pullRequest, installationId: installation.id },
  };
}
