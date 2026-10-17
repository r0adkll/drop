import { config } from "../config";
import { keptUntil, type Kept } from "../retention";

/** A Build as its page shows it. */
export interface PageBuild {
  id: string;
  applicationId: string;
  /** The config's display name, else the APK's label, else the application ID. */
  name: string;
  versionName: string | null;
  versionCode: number;
  repository: string;
  channel: { name: string; pullRequest: number | null; endedAt: number | null };
  runId: number;
  runNumber: number;
  workflow: string;
  commitSha: string;
  commitMessage: string | null;
  pullRequestTitle: string | null;
  releaseNotes: string | null;
  uploadedAt: number;
  fileSize: number;
  fileSha256: string;
  signerSha256: string;
  hasIcon: boolean;
  deletedAt: number | null;
  /** Why it was deleted: by retention, or removed by the Deployment's operator. */
  deletedReason: "retention" | "operator" | null;
}

/** Another Build a page links to: the newest of a Channel. */
export interface LinkedBuild {
  id: string;
  name: string;
  versionName: string | null;
  versionCode: number;
  uploadedAt: number;
  hasIcon: boolean;
}

export type BuildPageModel =
  | { kind: "not_found" }
  /** A Build of a Private product: milestone 1 serves Public products only. */
  | { kind: "private" }
  | {
      kind: "available";
      build: PageBuild;
      /** The Channel's newest Build, when it isn't this one. */
      newer: LinkedBuild | null;
      kept: Kept;
    }
  | {
      kind: "expired";
      build: PageBuild;
      /** Where the page sends Testers: the Channel's newest Build, or the default Channel's once it has ended. */
      next: { channel: string | null; build: LinkedBuild | null; because: "channel_open" | "channel_ended" };
    };

const BUILD_ID = /^[0-9A-Za-z]{8}$/;

interface BuildRow {
  id: string;
  application_id: string;
  label: string | null;
  version_name: string | null;
  version_code: number;
  repository: string;
  repository_visibility: string;
  form_factor: string;
  channel_id: number;
  channel_name: string;
  pull_request: number | null;
  ended_at: number | null;
  run_id: number;
  run_number: number;
  workflow: string;
  commit_sha: string;
  commit_message: string | null;
  pull_request_title: string | null;
  release_notes: string | null;
  uploaded_at: number;
  file_size: number;
  file_sha256: string;
  signer_sha256: string;
  icon_key: string | null;
  deleted_at: number | null;
  deleted_reason: "retention" | "operator" | null;
}

interface LinkedRow {
  id: string;
  application_id: string;
  label: string | null;
  version_name: string | null;
  version_code: number;
  uploaded_at: number;
  icon_key: string | null;
}

/** Whether a Product's Builds are open to anyone with a link (ADR 0010). */
export function isPublicProduct(applicationId: string, repositoryVisibility: string): boolean {
  return repositoryVisibility === "public" && config.products?.[applicationId]?.private !== true;
}

export function hasIcon(applicationId: string, iconKey: string | null): boolean {
  return iconKey !== null || config.products?.[applicationId]?.icon !== undefined;
}

function displayName(applicationId: string, label: string | null): string {
  return config.products?.[applicationId]?.displayName ?? label ?? applicationId;
}

// The newest Build of a Channel and Form factor (ADR 0017).
const NEWEST = `SELECT id, application_id, label, version_name, version_code, uploaded_at, icon_key FROM builds
  WHERE channel_id = ? AND form_factor = ? AND deleted_at IS NULL ORDER BY run_id DESC, uploaded_at DESC LIMIT 1`;

function linked(row: LinkedRow | null): LinkedBuild | null {
  if (!row) return null;
  return {
    id: row.id,
    name: displayName(row.application_id, row.label),
    versionName: row.version_name,
    versionCode: row.version_code,
    uploadedAt: row.uploaded_at,
    hasIcon: hasIcon(row.application_id, row.icon_key),
  };
}

/** Everything a Build page shows, and which state it is in. */
export async function loadBuildPage(db: D1Database, id: string): Promise<BuildPageModel> {
  if (!BUILD_ID.test(id)) return { kind: "not_found" };
  const row = await db
    .prepare(
      `SELECT b.id, b.application_id, b.label, b.version_name, b.version_code, p.repository, p.repository_visibility,
         b.form_factor, b.channel_id, c.name AS channel_name, c.pull_request, c.ended_at, b.run_id, b.run_number, b.workflow,
         b.commit_sha, b.commit_message, b.pull_request_title, b.release_notes, b.uploaded_at, b.file_size, b.file_sha256,
         b.signer_sha256, b.icon_key, b.deleted_at, b.deleted_reason
       FROM builds b JOIN products p ON p.application_id = b.application_id JOIN channels c ON c.id = b.channel_id
       WHERE b.id = ?`,
    )
    .bind(id)
    .first<BuildRow>();
  if (!row) return { kind: "not_found" };
  if (!isPublicProduct(row.application_id, row.repository_visibility)) return { kind: "private" };

  const build: PageBuild = {
    id: row.id,
    applicationId: row.application_id,
    name: displayName(row.application_id, row.label),
    versionName: row.version_name,
    versionCode: row.version_code,
    repository: row.repository,
    channel: { name: row.channel_name, pullRequest: row.pull_request, endedAt: row.ended_at },
    runId: row.run_id,
    runNumber: row.run_number,
    workflow: row.workflow,
    commitSha: row.commit_sha,
    commitMessage: row.commit_message,
    pullRequestTitle: row.pull_request_title,
    releaseNotes: row.release_notes,
    uploadedAt: row.uploaded_at,
    fileSize: row.file_size,
    fileSha256: row.file_sha256,
    signerSha256: row.signer_sha256,
    hasIcon: hasIcon(row.application_id, row.icon_key),
    deletedAt: row.deleted_at,
    deletedReason: row.deleted_reason,
  };
  const newest = linked(await db.prepare(NEWEST).bind(row.channel_id, row.form_factor).first<LinkedRow>());

  if (row.deleted_at === null) {
    const isNewest = newest === null || newest.id === row.id;
    return {
      kind: "available",
      build,
      newer: isNewest ? null : newest,
      kept: keptUntil({
        applicationId: row.application_id,
        uploadedAt: row.uploaded_at,
        pullRequest: row.pull_request !== null,
        channelEndedAt: row.ended_at,
        newest: isNewest,
      }),
    };
  }

  if (row.ended_at === null) {
    return { kind: "expired", build, next: { channel: row.channel_name, build: newest, because: "channel_open" } };
  }
  // The Channel has ended: send Testers to the default Channel, where the SDK sends them too.
  const fallback = await db
    .prepare("SELECT id, name FROM channels WHERE application_id = ? AND is_default = 1")
    .bind(row.application_id)
    .first<{ id: number; name: string }>();
  const next = fallback ? linked(await db.prepare(NEWEST).bind(fallback.id, row.form_factor).first<LinkedRow>()) : null;
  return { kind: "expired", build, next: { channel: fallback?.name ?? null, build: next, because: "channel_ended" } };
}
