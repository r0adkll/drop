// The hourly retention job (docs/design.md#retention). D1 decides what is kept; storage follows it:
// expiring a Build only marks its row, and a sweep then deletes every stored object no row refers
// to. The sweep also collects files that other deletions missed, such as a replaced attempt's files
// when their deletion after the swap failed.

import { keptUntil } from "./retention";

/** An upload not completed within a day is abandoned; its URLs expired long before. */
export const ABANDONED_UPLOAD_MS = 24 * 3_600_000;

/**
 * Objects younger than this are never swept. Every object's row is written before its upload URL is
 * handed out, so this only guards against clock skew between storage and the Worker.
 */
export const SWEEP_GRACE_MS = 3_600_000;

export interface RetentionResult {
  expiredBuilds: string[];
  abandonedUploads: number;
  deletedObjects: number;
}

export async function applyRetention(db: D1Database, bucket: R2Bucket, now: number): Promise<RetentionResult> {
  const expiredBuilds = await expireBuilds(db, now);
  const abandoned = await db.prepare("DELETE FROM uploads WHERE created_at <= ?").bind(now - ABANDONED_UPLOAD_MS).run();
  const deletedObjects = await sweepStorage(db, bucket, now);
  return { expiredBuilds, abandonedUploads: abandoned.meta.changes, deletedObjects };
}

/** Marks every Build the retention rules no longer keep as deleted, keeping its row and icon. */
async function expireBuilds(db: D1Database, now: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.application_id, b.uploaded_at, b.file_key, c.pull_request, c.ended_at,
         b.id = (SELECT b2.id FROM builds b2 WHERE b2.channel_id = b.channel_id AND b2.deleted_at IS NULL
                 ORDER BY b2.run_id DESC, b2.uploaded_at DESC LIMIT 1) AS newest
       FROM builds b JOIN channels c ON c.id = b.channel_id
       WHERE b.deleted_at IS NULL`,
    )
    .all<{ id: string; application_id: string; uploaded_at: number; file_key: string; pull_request: number | null; ended_at: number | null; newest: number }>();

  const expired = results.filter((row) => {
    const kept = keptUntil({
      applicationId: row.application_id,
      uploadedAt: row.uploaded_at,
      pullRequest: row.pull_request !== null,
      channelEndedAt: row.ended_at,
      newest: row.newest === 1,
    });
    return kept.kind === "until" && kept.at <= now;
  });
  // The file key guards against a later attempt of the run swapping in a fresh file meanwhile.
  const statements = expired.map((row) =>
    db.prepare("UPDATE builds SET deleted_at = ?, deleted_reason = 'retention' WHERE id = ? AND file_key = ? AND deleted_at IS NULL").bind(now, row.id, row.file_key),
  );
  const marked: string[] = [];
  for (let i = 0; i < statements.length; i += 50) {
    const outcomes = await db.batch(statements.slice(i, i + 50));
    outcomes.forEach((outcome, j) => {
      if (outcome.meta.changes > 0) marked.push(expired[i + j]!.id);
    });
  }
  return marked;
}

/** Deletes stored objects no Build or upload refers to. Returns how many were deleted. */
async function sweepStorage(db: D1Database, bucket: R2Bucket, now: number): Promise<number> {
  // List first: an object listed now had its row written before it was uploaded, so the D1 read
  // that follows sees that row (or its successor) unless it has really been let go.
  const listed: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "builds/", cursor });
    listed.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const { results } = await db
    .prepare(
      `SELECT file_key AS key FROM builds WHERE deleted_at IS NULL
       UNION SELECT icon_key FROM builds WHERE icon_key IS NOT NULL
       UNION SELECT file_key FROM uploads
       UNION SELECT icon_key FROM uploads WHERE icon_key IS NOT NULL`,
    )
    .all<{ key: string }>();
  const referenced = new Set(results.map((row) => row.key));
  const unreferenced = listed.filter((object) => !referenced.has(object.key) && object.uploaded.getTime() <= now - SWEEP_GRACE_MS).map((object) => object.key);
  for (let i = 0; i < unreferenced.length; i += 1000) await bucket.delete(unreferenced.slice(i, i + 1000));
  return unreferenced.length;
}
