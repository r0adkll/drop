import type { AllowedRepositories } from "./allowed-repositories";
import { config } from "./config";
import { ApiError } from "./errors";
import type { components } from "./generated/openapi";
import { newBuildId } from "./ids";
import type { GitHubClaims } from "./oidc";
import { bytesToHex, type Presigner } from "./presign";

export type CreateUploadRequest = components["schemas"]["CreateUploadRequest"];
export type CreateUploadResponse = components["schemas"]["CreateUploadResponse"];
export type UploadedBuild = components["schemas"]["UploadedBuild"];

/** How long presigned upload URLs work. Tokens last minutes too, so the whole upload fits inside. */
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;

// Both events run with the repository's permissions while handling a fork's pull request, so they
// upload only where the allow-list says so (docs/design.md#upload-authentication).
const RESTRICTED_EVENTS = new Set(["pull_request_target", "workflow_run"]);
const DEFAULT_BRANCH_EVENTS = new Set(["push", "workflow_dispatch", "schedule"]);
const PULL_REQUEST_CHANNEL = /^pr\/([1-9][0-9]{0,9})$/;

export function buildUrl(id: string): string {
  return `${config.url}/b/${id}`;
}

// ---------------------------------------------------------------------------------------------
// Request validation. Hand-written to keep request CPU low; mirrors CreateUploadRequest in
// openapi.yaml.

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const APPLICATION_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function parseCreateUpload(body: unknown): CreateUploadRequest {
  const fail = (field: string, problem: string): never => {
    throw new ApiError(400, "invalid_request", `${field} ${problem}.`);
  };
  const object = (value: unknown, field: string, keys: readonly string[]): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(field, "must be an object");
    for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${field}.${key}`, "is not a known field");
    return value as Record<string, unknown>;
  };
  const string = (value: unknown, field: string, max: number, pattern?: RegExp): string => {
    if (typeof value !== "string" || value.length === 0 || value.length > max) return fail(field, `must be a string of 1 to ${max} characters`);
    if (pattern && !pattern.test(value)) fail(field, "has an invalid format");
    return value;
  };
  const optionalString = (value: unknown, field: string, max: number): string | undefined =>
    value === undefined ? undefined : string(value, field, max);
  const integer = (value: unknown, field: string, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) return fail(field, `must be an integer from ${min} to ${max}`);
    return value;
  };

  const root = object(body, "body", [
    "applicationId", "versionCode", "versionName", "label", "signerSha256", "apk", "icon", "channel",
    "defaultBranch", "commit", "pullRequestTitle",
  ]);
  const apk = object(root.apk, "apk", ["size", "sha256"]);
  const commit = object(root.commit, "commit", ["sha", "message"]);
  if (typeof root.defaultBranch !== "boolean") fail("defaultBranch", "must be a boolean");

  const request: CreateUploadRequest = {
    applicationId: string(root.applicationId, "applicationId", 255, APPLICATION_ID),
    versionCode: integer(root.versionCode, "versionCode", 1, 2_100_000_000),
    versionName: optionalString(root.versionName, "versionName", 100),
    label: optionalString(root.label, "label", 200),
    signerSha256: string(root.signerSha256, "signerSha256", 64, SHA256),
    apk: { size: integer(apk.size, "apk.size", 1, 5_000_000_000), sha256: string(apk.sha256, "apk.sha256", 64, SHA256) },
    channel: string(root.channel, "channel", 64, CHANNEL),
    defaultBranch: root.defaultBranch as boolean,
    commit: { sha: string(commit.sha, "commit.sha", 40, COMMIT_SHA), message: optionalString(commit.message, "commit.message", 10_000) },
    pullRequestTitle: optionalString(root.pullRequestTitle, "pullRequestTitle", 1000),
  };
  if (root.icon !== undefined) {
    const icon = object(root.icon, "icon", ["size", "sha256", "contentType"]);
    if (icon.contentType !== "image/png" && icon.contentType !== "image/webp") fail("icon.contentType", "must be image/png or image/webp");
    request.icon = {
      size: integer(icon.size, "icon.size", 1, 1_048_576),
      sha256: string(icon.sha256, "icon.sha256", 64, SHA256),
      contentType: icon.contentType as "image/png" | "image/webp",
    };
  }
  return request;
}

// ---------------------------------------------------------------------------------------------
// Rules

export interface ChannelTarget {
  name: string;
  /** The pull request number of a Pull request channel. */
  pullRequest: number | null;
  /** Whether the upload makes this the Product's default Channel. */
  isDefault: boolean;
}

/** Channel rules from docs/design.md#channels, checked against the token rather than trusted. */
export function resolveChannel(request: Pick<CreateUploadRequest, "channel" | "defaultBranch">, claims: Pick<GitHubClaims, "ref" | "eventName">): ChannelTarget {
  const { channel: name, defaultBranch } = request;
  if (name.includes("//") || name.endsWith("/")) throw new ApiError(400, "channel_invalid", `"${name}" is not a valid Channel name.`);

  const pr = PULL_REQUEST_CHANNEL.exec(name);
  if (pr) {
    const number = Number(pr[1]);
    if (defaultBranch || claims.ref !== `refs/pull/${number}/merge`) {
      throw new ApiError(403, "channel_ref_mismatch", `Only runs of pull request #${number} may upload to ${name}; this run is for ${claims.ref}.`);
    }
    return { name, pullRequest: number, isDefault: false };
  }
  if (name.startsWith("pr/")) throw new ApiError(400, "channel_invalid", `"${name}" is not a valid Channel name; pull request Channels are pr/<number>.`);

  if (defaultBranch && (!claims.ref.startsWith("refs/heads/") || !DEFAULT_BRANCH_EVENTS.has(claims.eventName))) {
    throw new ApiError(403, "default_branch_ref_invalid", `A ${claims.eventName} run on ${claims.ref} can't upload to the default Channel.`);
  }
  return { name, pullRequest: null, isDefault: defaultBranch };
}

/**
 * One Build per Product per run (ADR 0013). An upload in flight is always replaced; a confirmed Build
 * only by a later attempt of the run, and it keeps serving until that attempt is confirmed.
 */
export function mayUpload(confirmedAttempt: number | null, runAttempt: number): boolean {
  return confirmedAttempt === null || runAttempt > confirmedAttempt;
}

// ---------------------------------------------------------------------------------------------
// Handlers

export interface UploadContext {
  env: Env;
  claims: GitHubClaims;
  allowedRepositories: AllowedRepositories;
  presigner: Presigner;
  now: number;
  /** Runs work after the response, such as deleting replaced files. */
  waitUntil: (promise: Promise<unknown>) => void;
  /**
   * Rebuilds the installation record from GitHub, rate-limited; true when it ran. A denial may only
   * mean a webhook was missed, so a denied upload resyncs and checks once more.
   */
  resyncInstallations?: () => Promise<boolean>;
}

export async function createUpload(ctx: UploadContext, request: CreateUploadRequest): Promise<CreateUploadResponse> {
  const { env, claims, now } = ctx;
  const db = env.DB;

  let decision = await ctx.allowedRepositories.check(claims);
  if (!decision.allowed && decision.code !== "owner_not_listed" && (await ctx.resyncInstallations?.())) {
    decision = await ctx.allowedRepositories.check(claims);
  }
  if (!decision.allowed) throw new ApiError(403, decision.code, decision.reason);
  if (RESTRICTED_EVENTS.has(claims.eventName) && !(decision.allowEvents as readonly string[]).includes(claims.eventName)) {
    throw new ApiError(403, "event_not_allowed", `${claims.repository} may not upload from ${claims.eventName} runs.`);
  }
  const target = resolveChannel(request, claims);

  // Product: bound to the first repository that uploads it (ADR 0015).
  await db
    .prepare(
      `INSERT INTO products (application_id, repository_id, repository, repository_visibility, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (application_id) DO NOTHING`,
    )
    .bind(request.applicationId, claims.repositoryId, claims.repository, claims.repositoryVisibility, now)
    .run();
  const product = await db.prepare("SELECT repository_id FROM products WHERE application_id = ?").bind(request.applicationId).first<{ repository_id: number }>();
  if (!product || product.repository_id !== claims.repositoryId) {
    throw new ApiError(403, "product_bound_to_other_repository", `${request.applicationId} is uploaded from another repository.`);
  }
  await db
    .prepare("UPDATE products SET repository = ?, repository_visibility = ? WHERE application_id = ?")
    .bind(claims.repository, claims.repositoryVisibility, request.applicationId)
    .run();

  const channelId = await upsertChannel(db, request.applicationId, target, now);

  // Upload row. The confirmed Build, if any, is left untouched until completeUpload swaps it.
  const [confirmed, inFlight] = await Promise.all([
    db
      .prepare("SELECT id, run_attempt FROM builds WHERE application_id = ? AND run_id = ?")
      .bind(request.applicationId, claims.runId)
      .first<{ id: string; run_attempt: number }>(),
    db
      .prepare("SELECT build_id, file_key, icon_key FROM uploads WHERE application_id = ? AND run_id = ?")
      .bind(request.applicationId, claims.runId)
      .first<{ build_id: string; file_key: string; icon_key: string | null }>(),
  ]);
  if (!mayUpload(confirmed?.run_attempt ?? null, claims.runAttempt)) {
    throw new ApiError(409, "build_exists_for_run", `Run ${claims.runId} attempt ${confirmed!.run_attempt} already uploaded ${request.applicationId}; only a later attempt can replace it.`);
  }

  const id = confirmed?.id ?? inFlight?.build_id ?? (await reserveBuildId(db));
  const fileKey = `builds/${id}/${claims.runAttempt}/app.apk`;
  const iconKey = request.icon ? `builds/${id}/${claims.runAttempt}/icon.${request.icon.contentType === "image/png" ? "png" : "webp"}` : null;
  await db
    .prepare(
      `INSERT INTO uploads (build_id, application_id, channel_id, run_id, run_attempt, workflow, run_number, event_name,
         ref, commit_sha, built_sha, commit_message, pull_request_title, version_code, version_name, label,
         signer_sha256, file_size, file_sha256, file_key, icon_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (build_id) DO UPDATE SET channel_id = excluded.channel_id, run_attempt = excluded.run_attempt,
         workflow = excluded.workflow, run_number = excluded.run_number, event_name = excluded.event_name,
         ref = excluded.ref, commit_sha = excluded.commit_sha, built_sha = excluded.built_sha,
         commit_message = excluded.commit_message, pull_request_title = excluded.pull_request_title,
         version_code = excluded.version_code, version_name = excluded.version_name, label = excluded.label,
         signer_sha256 = excluded.signer_sha256, file_size = excluded.file_size, file_sha256 = excluded.file_sha256,
         file_key = excluded.file_key, icon_key = excluded.icon_key, created_at = excluded.created_at`,
    )
    .bind(
      id, request.applicationId, channelId, claims.runId, claims.runAttempt, claims.workflow, claims.runNumber,
      claims.eventName, claims.ref, request.commit.sha, claims.sha, request.commit.message ?? null,
      request.pullRequestTitle ?? null, request.versionCode, request.versionName ?? null, request.label ?? null,
      request.signerSha256, request.apk.size, request.apk.sha256, fileKey, iconKey, now,
    )
    .run();
  // A replaced upload's files were never offered, so they can go now; same-attempt retries reuse keys.
  if (inFlight) {
    const stale = [inFlight.file_key, inFlight.icon_key].filter((key): key is string => key !== null && key !== fileKey && key !== iconKey);
    if (stale.length > 0) ctx.waitUntil(env.BUILDS.delete(stale));
  }

  const [apk, icon] = await Promise.all([
    ctx.presigner.presignPut(fileKey, request.apk.sha256, UPLOAD_URL_TTL_SECONDS),
    request.icon && iconKey ? ctx.presigner.presignPut(iconKey, request.icon.sha256, UPLOAD_URL_TTL_SECONDS) : undefined,
  ]);
  return {
    buildId: id,
    buildUrl: buildUrl(id),
    expiresAt: new Date(now + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    apk,
    ...(icon ? { icon } : {}),
  };
}

async function upsertChannel(db: D1Database, applicationId: string, target: ChannelTarget, now: number): Promise<number> {
  const channel = await db
    .prepare("SELECT id, is_default, ended_at FROM channels WHERE application_id = ? AND name = ?")
    .bind(applicationId, target.name)
    .first<{ id: number; is_default: number; ended_at: number | null }>();
  if (channel?.ended_at != null) {
    throw new ApiError(409, "channel_ended", `${target.name} has ended because its pull request was closed.`);
  }
  // A default-branch upload makes its Channel the default, moving the mark if the run names a
  // different Channel than before (docs/design.md#channels).
  const clearDefault = db.prepare("UPDATE channels SET is_default = 0 WHERE application_id = ? AND is_default = 1").bind(applicationId);
  if (channel) {
    if (target.isDefault && channel.is_default === 0) {
      await db.batch([clearDefault, db.prepare("UPDATE channels SET is_default = 1 WHERE id = ?").bind(channel.id)]);
    }
    return channel.id;
  }
  const insert = db
    .prepare(
      `INSERT INTO channels (application_id, name, is_default, pull_request, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (application_id, name) DO NOTHING`,
    )
    .bind(applicationId, target.name, target.isDefault ? 1 : 0, target.pullRequest, now);
  await db.batch(target.isDefault ? [clearDefault, insert] : [insert]);
  const created = await db.prepare("SELECT id FROM channels WHERE application_id = ? AND name = ?").bind(applicationId, target.name).first<{ id: number }>();
  return created!.id;
}

/** A new Build ID, unused by any Build or upload. */
async function reserveBuildId(db: D1Database): Promise<string> {
  for (let tries = 0; tries < 5; tries++) {
    const id = newBuildId();
    const taken = await db
      .prepare("SELECT 1 FROM builds WHERE id = ?1 UNION ALL SELECT 1 FROM uploads WHERE build_id = ?1")
      .bind(id)
      .first();
    if (!taken) return id;
  }
  throw new Error("Could not find an unused Build ID.");
}

const BUILD_COLUMNS = `application_id, channel_id, run_id, run_attempt, workflow, run_number, event_name, ref, commit_sha,
  built_sha, commit_message, pull_request_title, version_code, version_name, label, signer_sha256, file_size,
  file_sha256, file_key`;

export async function completeUpload(ctx: Pick<UploadContext, "env" | "claims" | "now" | "waitUntil">, buildId: string): Promise<UploadedBuild> {
  const { env, claims } = ctx;
  const db = env.DB;
  const result = { buildId, buildUrl: buildUrl(buildId) };
  const sameRun = (row: { repository_id: number; run_id: number; run_attempt: number }) =>
    row.repository_id === claims.repositoryId && row.run_id === claims.runId && row.run_attempt === claims.runAttempt;

  const upload = await db
    .prepare(
      `SELECT u.run_id, u.run_attempt, u.file_key, u.file_size, u.file_sha256, u.icon_key, p.repository_id
       FROM uploads u JOIN products p ON p.application_id = u.application_id WHERE u.build_id = ?`,
    )
    .bind(buildId)
    .first<{ run_id: number; run_attempt: number; file_key: string; file_size: number; file_sha256: string; icon_key: string | null; repository_id: number }>();
  const confirmed = await db
    .prepare(
      `SELECT b.run_id, b.run_attempt, b.file_key, b.icon_key, p.repository_id
       FROM builds b JOIN products p ON p.application_id = b.application_id WHERE b.id = ?`,
    )
    .bind(buildId)
    .first<{ run_id: number; run_attempt: number; file_key: string; icon_key: string | null; repository_id: number }>();

  if (!upload) {
    // Completing again after success changes nothing.
    if (confirmed && sameRun(confirmed)) return result;
    if (confirmed) throw new ApiError(403, "build_run_mismatch", `Build ${buildId} was uploaded by a different run attempt.`);
    throw new ApiError(404, "build_not_found", `There is no Build ${buildId}.`);
  }
  if (!sameRun(upload)) throw new ApiError(403, "build_run_mismatch", `Build ${buildId} was started by a different run attempt.`);

  const apk = await env.BUILDS.head(upload.file_key);
  if (!apk) throw new ApiError(409, "file_missing", "The APK has not been uploaded.");
  if (apk.size !== upload.file_size) {
    await env.BUILDS.delete(upload.file_key);
    throw new ApiError(409, "file_size_mismatch", `The uploaded APK is ${apk.size} bytes, not ${upload.file_size}.`);
  }
  // Present only if storage verified a checksum on upload; otherwise the size check stands alone and
  // the SDK's SHA-256 check before install is the backstop (docs/implementation-notes.md#cloudflare).
  const stored = apk.checksums.sha256;
  if (stored && bytesToHex(stored) !== upload.file_sha256) {
    await env.BUILDS.delete(upload.file_key);
    throw new ApiError(409, "file_checksum_mismatch", "The uploaded APK's SHA-256 doesn't match.");
  }
  const iconKey = upload.icon_key && (await env.BUILDS.head(upload.icon_key)) ? upload.icon_key : null;

  // Swap in one batch: the Build takes the attempt's values and the upload row goes. A later attempt
  // keeps the Build's ID, so its page and Stamp keep resolving (ADR 0013).
  await db.batch([
    db
      .prepare(
        `INSERT INTO builds (id, ${BUILD_COLUMNS}, icon_key, uploaded_at)
         SELECT build_id, ${BUILD_COLUMNS}, ?, ? FROM uploads WHERE build_id = ?
         ON CONFLICT (id) DO UPDATE SET channel_id = excluded.channel_id, run_attempt = excluded.run_attempt,
           workflow = excluded.workflow, run_number = excluded.run_number, event_name = excluded.event_name,
           ref = excluded.ref, commit_sha = excluded.commit_sha, built_sha = excluded.built_sha,
           commit_message = excluded.commit_message, pull_request_title = excluded.pull_request_title,
           version_code = excluded.version_code, version_name = excluded.version_name, label = excluded.label,
           signer_sha256 = excluded.signer_sha256, file_size = excluded.file_size, file_sha256 = excluded.file_sha256,
           file_key = excluded.file_key, icon_key = excluded.icon_key, uploaded_at = excluded.uploaded_at,
           deleted_at = NULL`,
      )
      .bind(iconKey, ctx.now, buildId),
    db.prepare("DELETE FROM uploads WHERE build_id = ?").bind(buildId),
  ]);
  // The replaced attempt's files go only once the swap has landed.
  if (confirmed) {
    const replaced = [confirmed.file_key, confirmed.icon_key].filter((key): key is string => key !== null && key !== upload.file_key && key !== iconKey);
    if (replaced.length > 0) ctx.waitUntil(env.BUILDS.delete(replaced));
  }
  return result;
}
