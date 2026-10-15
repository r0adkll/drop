// Rebuilds the record of the App's installations from GitHub itself, repairing whatever webhooks
// missed: lost deliveries, and switches from all repositories to selected ones, which report only
// the repositories removed (ADR 0004).

import { addRepository, isInstallation, isListedOwner, upsertInstallation, type WebhookInstallation, type WebhookRepository } from "../github-webhook";
import type { GitHubApp } from "./client";

/** Resyncs triggered by denied uploads run at most this often. */
export const RESYNC_INTERVAL_MS = 60 * 1000;

/**
 * Replaces D1's installations of listed Owners with what GitHub reports. Installations by other
 * accounts are skipped, as the webhook skips them.
 */
export async function resyncInstallations(db: D1Database, github: GitHubApp, owners: Record<string, number>, now: number): Promise<void> {
  const ownerIds = Object.values(owners);
  if (ownerIds.length === 0) return;

  const installations = (await github.list<WebhookInstallation>("/app/installations")).filter(
    (installation) => isInstallation(installation) && isListedOwner(owners, installation.account),
  );
  for (const installation of installations) {
    const statements = upsertInstallation(db, installation, installation.repository_selection, now);
    if (installation.suspended_at) {
      // A suspended installation can't get a token; its repositories stay as last recorded.
    } else if (installation.repository_selection === "selected") {
      const repositories = await github.list<WebhookRepository>("/installation/repositories", { installation: installation.id, key: "repositories" });
      statements.push(
        db.prepare("DELETE FROM installation_repositories WHERE installation_id = ?").bind(installation.id),
        ...repositories.map((repository) => addRepository(db, installation.id, repository)),
      );
    } else {
      // With "all" the check ignores the list, so there is nothing worth keeping.
      statements.push(db.prepare("DELETE FROM installation_repositories WHERE installation_id = ?").bind(installation.id));
    }
    await db.batch(statements);
  }

  // Installations of listed Owners that GitHub no longer reports have been uninstalled.
  const owned = ownerIds.map(() => "?").join(", ");
  const kept = installations.map((installation) => installation.id);
  const stale = kept.length > 0 ? `AND id NOT IN (${kept.map(() => "?").join(", ")})` : "";
  await db.batch([
    db
      .prepare(`DELETE FROM installation_repositories WHERE installation_id IN (SELECT id FROM installations WHERE account_id IN (${owned}) ${stale})`)
      .bind(...ownerIds, ...kept),
    db.prepare(`DELETE FROM installations WHERE account_id IN (${owned}) ${stale}`).bind(...ownerIds, ...kept),
  ]);
}

/**
 * Claims the right to resync now, at most once per RESYNC_INTERVAL_MS across every isolate: true
 * when this caller should run it.
 */
export async function claimResync(db: D1Database, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO sync_state (name, synced_at) VALUES ('installations', ?1)
       ON CONFLICT (name) DO UPDATE SET synced_at = excluded.synced_at WHERE sync_state.synced_at <= ?2`,
    )
    .bind(now, now - RESYNC_INTERVAL_MS)
    .run();
  return result.meta.changes > 0;
}
