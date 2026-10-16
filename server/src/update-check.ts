// The Update check (docs/design.md#update-check): what an installed Build should be offered.

import { isPublicProduct } from "./build-page/model";
import { config } from "./config";
import { ApiError } from "./errors";
import type { components } from "./generated/openapi";
import { buildUrl } from "./uploads";

export type UpdateCheck = components["schemas"]["UpdateCheck"];
export type Update = components["schemas"]["Update"];

/** How long an Update's download URL is promised to work (docs/design.md#sdk). */
export const DOWNLOAD_URL_TTL_MS = 60 * 60 * 1000;

export interface InstalledBuild {
  applicationId: string;
  channel: string;
  /** From the Stamp; absent for a Build with no Stamp. */
  runId?: number;
  signer: string;
  versionCode: number;
}

const APPLICATION_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/;

/** Reads and checks the query parameters. */
export function parseUpdateCheck(query: URLSearchParams): InstalledBuild {
  const fail = (name: string, rule: string): never => {
    throw new ApiError(400, "invalid_request", `${name} ${rule}.`);
  };
  const applicationId = query.get("applicationId") ?? fail("applicationId", "is required");
  if (applicationId.length > 255 || !APPLICATION_ID.test(applicationId)) fail("applicationId", "must be an Android application ID");
  const channel = query.get("channel") ?? fail("channel", "is required");
  if (channel.length > 64 || !CHANNEL.test(channel)) fail("channel", "must be a Channel name");
  const signer = (query.get("signer") ?? fail("signer", "is required")).toLowerCase();
  if (!SHA256.test(signer)) fail("signer", "must be a SHA-256 digest in hex");
  const versionCode = query.get("versionCode") ?? fail("versionCode", "is required");
  if (!POSITIVE_INTEGER.test(versionCode)) fail("versionCode", "must be a positive integer");
  const runId = query.get("runId");
  if (runId !== null && !POSITIVE_INTEGER.test(runId)) fail("runId", "must be a positive integer");
  return {
    applicationId,
    channel,
    signer,
    versionCode: Number(versionCode),
    ...(runId !== null ? { runId: Number(runId) } : {}),
  };
}

interface BuildRow {
  id: string;
  application_id: string;
  channel: string;
  pull_request: number | null;
  label: string | null;
  version_name: string | null;
  version_code: number;
  uploaded_at: number;
  commit_sha: string;
  commit_message: string | null;
  pull_request_title: string | null;
  signer_sha256: string;
  file_size: number;
  file_sha256: string;
}

const BUILD_COLUMNS = `b.id, b.application_id, c.name AS channel, c.pull_request, b.label, b.version_name, b.version_code,
  b.uploaded_at, b.commit_sha, b.commit_message, b.pull_request_title, b.signer_sha256, b.file_size, b.file_sha256`;

export async function checkForUpdate(db: D1Database, installed: InstalledBuild, now: number): Promise<UpdateCheck> {
  const product = await db
    .prepare("SELECT repository_visibility FROM products WHERE application_id = ?")
    .bind(installed.applicationId)
    .first<{ repository_visibility: string }>();
  if (!product) throw new ApiError(404, "product_not_found", `There is no Product ${installed.applicationId}.`);
  if (!isPublicProduct(installed.applicationId, product.repository_visibility)) {
    throw new ApiError(403, "sign_in_required", "This Product's Builds need sign-in, which this server doesn't offer yet.");
  }

  const channel = await db
    .prepare("SELECT id, ended_at FROM channels WHERE application_id = ? AND name = ?")
    .bind(installed.applicationId, installed.channel)
    .first<{ id: number; ended_at: number | null }>();
  if (!channel) return { status: "up_to_date" };

  if (channel.ended_at !== null) {
    // Switch to the default Channel's newest Build, whatever its run ID: the installed Signer's
    // newest, or else the newest of all, flagged as needing a reinstall.
    const offered = await db
      .prepare(
        `SELECT ${BUILD_COLUMNS} FROM builds b JOIN channels c ON c.id = b.channel_id
         WHERE c.application_id = ? AND c.is_default = 1 AND b.deleted_at IS NULL
         ORDER BY b.signer_sha256 = ? DESC, b.run_id DESC, b.uploaded_at DESC LIMIT 1`,
      )
      .bind(installed.applicationId, installed.signer)
      .first<BuildRow>();
    return { status: "channel_ended", update: offered ? toUpdate(offered, installed, now) : null };
  }

  // Newer: a higher run ID on this Channel (ADR 0009), or any Build without a Stamp (ADR 0013).
  const { results: newer } = await db
    .prepare(
      `SELECT ${BUILD_COLUMNS} FROM builds b JOIN channels c ON c.id = b.channel_id
       WHERE b.channel_id = ? AND b.deleted_at IS NULL AND b.run_id > ?
       ORDER BY b.run_id DESC, b.uploaded_at DESC`,
    )
    .bind(channel.id, installed.runId ?? 0)
    .all<BuildRow>();
  if (newer.length === 0) return { status: "up_to_date" };
  const sameSigner = newer.find((build) => build.signer_sha256 === installed.signer);
  if (sameSigner) return { status: "update", update: toUpdate(sameSigner, installed, now) };
  return { status: "reinstall_required", update: toUpdate(newer[0]!, installed, now) };
}

function toUpdate(build: BuildRow, installed: InstalledBuild, now: number): Update {
  const name = config.products?.[build.application_id]?.displayName ?? build.label ?? build.application_id;
  const commitLine = build.commit_message?.split(/\r?\n/, 1)[0]?.trim() || null;
  const requiresReinstall =
    build.signer_sha256 !== installed.signer ? "signer" : build.version_code < installed.versionCode ? "version_code" : undefined;
  return {
    buildId: build.id,
    channel: build.channel,
    label: name,
    versionName: build.version_name,
    versionCode: build.version_code,
    uploadedAt: new Date(build.uploaded_at).toISOString(),
    headline: build.pull_request_title || commitLine || name,
    commitSha: build.commit_sha,
    pullRequest: build.pull_request,
    buildUrl: buildUrl(build.id),
    fileSize: build.file_size,
    fileSha256: build.file_sha256,
    downloadUrl: `${buildUrl(build.id)}/download`,
    downloadUrlExpiresAt: new Date(now + DOWNLOAD_URL_TTL_MS).toISOString(),
    ...(requiresReinstall ? { requiresReinstall } : {}),
  };
}
