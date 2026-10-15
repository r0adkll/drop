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

export interface ExistingBuild {
  runAttempt: number;
  confirmed: boolean;
}

/**
 * One Build per Product per run (ADR 0013): a pending Build is always replaced, a confirmed one only by
 * a later attempt of the run.
 */
export function replacementFor(existing: ExistingBuild | null, runAttempt: number): "insert" | "replace" | "reject" {
  if (!existing) return "insert";
  if (!existing.confirmed || runAttempt > existing.runAttempt) return "replace";
  return "reject";
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
}

export async function createUpload(ctx: UploadContext, request: CreateUploadRequest): Promise<CreateUploadResponse> {
  const { env, claims, now } = ctx;
  const db = env.DB;

  const decision = await ctx.allowedRepositories.check(claims);
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

  // Build row.
  const existing = await db
    .prepare("SELECT id, run_attempt, uploaded_at, file_key, icon_key FROM builds WHERE application_id = ? AND run_id = ?")
    .bind(request.applicationId, claims.runId)
    .first<{ id: string; run_attempt: number; uploaded_at: number | null; file_key: string; icon_key: string | null }>();
  const action = replacementFor(existing && { runAttempt: existing.run_attempt, confirmed: existing.uploaded_at !== null }, claims.runAttempt);
  if (action === "reject") {
    throw new ApiError(409, "build_exists_for_run", `Run ${claims.runId} attempt ${existing!.run_attempt} already uploaded ${request.applicationId}; only a later attempt can replace it.`);
  }

  const id = existing?.id ?? newBuildId();
  const fileKey = `builds/${id}/${claims.runAttempt}/app.apk`;
  const iconKey = request.icon ? `builds/${id}/${claims.runAttempt}/icon.${request.icon.contentType === "image/png" ? "png" : "webp"}` : null;
  const values = [
    request.applicationId, channelId, claims.runId, claims.runAttempt, claims.workflow, claims.runNumber,
    claims.eventName, claims.ref, request.commit.sha, claims.sha, request.commit.message ?? null,
    request.pullRequestTitle ?? null, request.versionCode, request.versionName ?? null, request.label ?? null,
    request.signerSha256, request.apk.size, request.apk.sha256, fileKey, iconKey, now,
  ];
  if (action === "insert") {
    await db
      .prepare(
        `INSERT INTO builds (application_id, channel_id, run_id, run_attempt, workflow, run_number, event_name, ref,
           commit_sha, built_sha, commit_message, pull_request_title, version_code, version_name, label,
           signer_sha256, file_size, file_sha256, file_key, icon_key, created_at, id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(...values, id)
      .run();
  } else {
    await db
      .prepare(
        `UPDATE builds SET application_id = ?, channel_id = ?, run_id = ?, run_attempt = ?, workflow = ?, run_number = ?,
           event_name = ?, ref = ?, commit_sha = ?, built_sha = ?, commit_message = ?, pull_request_title = ?,
           version_code = ?, version_name = ?, label = ?, signer_sha256 = ?, file_size = ?, file_sha256 = ?,
           file_key = ?, icon_key = ?, created_at = ?, uploaded_at = NULL, deleted_at = NULL
         WHERE id = ?`,
      )
      .bind(...values, id)
      .run();
    const stale = [existing!.file_key, existing!.icon_key].filter((key): key is string => key !== null && key !== fileKey && key !== iconKey);
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

export async function completeUpload(ctx: Pick<UploadContext, "env" | "claims" | "now">, buildId: string): Promise<UploadedBuild> {
  const { env, claims } = ctx;
  const build = await env.DB
    .prepare(
      `SELECT b.run_id, b.run_attempt, b.uploaded_at, b.file_key, b.file_size, b.file_sha256, b.icon_key, p.repository_id
       FROM builds b JOIN products p ON p.application_id = b.application_id WHERE b.id = ?`,
    )
    .bind(buildId)
    .first<{
      run_id: number; run_attempt: number; uploaded_at: number | null; file_key: string; file_size: number;
      file_sha256: string; icon_key: string | null; repository_id: number;
    }>();
  if (!build) throw new ApiError(404, "build_not_found", `There is no Build ${buildId}.`);
  if (build.repository_id !== claims.repositoryId || build.run_id !== claims.runId || build.run_attempt !== claims.runAttempt) {
    throw new ApiError(403, "build_run_mismatch", `Build ${buildId} was started by a different run attempt.`);
  }
  const result = { buildId, buildUrl: buildUrl(buildId) };
  if (build.uploaded_at !== null) return result;

  const apk = await env.BUILDS.head(build.file_key);
  if (!apk) throw new ApiError(409, "file_missing", "The APK has not been uploaded.");
  if (apk.size !== build.file_size) {
    await env.BUILDS.delete(build.file_key);
    throw new ApiError(409, "file_size_mismatch", `The uploaded APK is ${apk.size} bytes, not ${build.file_size}.`);
  }
  // Present only if storage verified a checksum on upload; otherwise the size check stands alone and
  // the SDK's SHA-256 check before install is the backstop (docs/implementation-notes.md#cloudflare).
  const stored = apk.checksums.sha256;
  if (stored && bytesToHex(stored) !== build.file_sha256) {
    await env.BUILDS.delete(build.file_key);
    throw new ApiError(409, "file_checksum_mismatch", "The uploaded APK's SHA-256 doesn't match.");
  }
  const iconKey = build.icon_key && (await env.BUILDS.head(build.icon_key)) ? build.icon_key : null;

  await env.DB
    .prepare("UPDATE builds SET uploaded_at = ?, icon_key = ? WHERE id = ? AND uploaded_at IS NULL")
    .bind(ctx.now, iconKey, buildId)
    .run();
  return result;
}
