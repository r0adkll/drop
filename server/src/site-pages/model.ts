// What the index, Product and Channel pages show (docs/design.md#site-pages), read from D1. Only
// Public products are listed; a Private product's pages say it needs sign-in, as its Build pages do.

import { isPublicProduct } from "../build-page/model";
import { config } from "../config";
import { keptUntil, type Kept } from "../retention";

export interface BuildSummary {
  id: string;
  versionName: string | null;
  versionCode: number;
  headline: string;
  commitSha: string;
  commitLine: string | null;
  workflow: string;
  runNumber: number;
  runId: number;
  uploadedAt: number;
  fileSize: number;
}

export interface ChannelSummary {
  name: string;
  isDefault: boolean;
  pullRequest: number | null;
  /** The pull request's title, from its newest Build. */
  pullRequestTitle: string | null;
  endedAt: number | null;
  merged: boolean;
  newest: BuildSummary;
  liveBuilds: number;
}

export interface ProductSummary {
  applicationId: string;
  name: string;
  repository: string;
  /** A Build whose /icon route serves the Product's icon, if it has one. */
  iconBuildId: string | null;
  channels: ChannelSummary[];
  lastUploadAt: number;
}

export type ProductPageModel = { kind: "product"; product: ProductSummary } | { kind: "private" } | { kind: "not_found" };

export interface ChannelBuild extends BuildSummary {
  newest: boolean;
  kept: Kept;
}

export type ChannelPageModel =
  | { kind: "channel"; product: ProductSummary; channel: ChannelSummary; builds: ChannelBuild[] }
  | {
      kind: "ended";
      product: ProductSummary;
      channel: { name: string; pullRequest: number | null; pullRequestTitle: string | null; endedAt: number; merged: boolean };
      /** The default Channel's newest Build, where Testers are sent. */
      next: { channel: string; build: BuildSummary } | null;
    }
  | { kind: "private" }
  | { kind: "not_found" };

interface BuildRow {
  id: string;
  label: string | null;
  version_name: string | null;
  version_code: number;
  uploaded_at: number;
  file_size: number;
  commit_sha: string;
  commit_message: string | null;
  pull_request_title: string | null;
  workflow: string;
  run_number: number;
  run_id: number;
  icon_key: string | null;
}

const BUILD_COLUMNS = `b.id, b.label, b.version_name, b.version_code, b.uploaded_at, b.file_size, b.commit_sha, b.commit_message,
  b.pull_request_title, b.workflow, b.run_number, b.run_id, b.icon_key`;

function summary(row: BuildRow, name: string): BuildSummary {
  const commitLine = row.commit_message?.split(/\r?\n/, 1)[0]?.trim() || null;
  return {
    id: row.id,
    versionName: row.version_name,
    versionCode: row.version_code,
    headline: row.pull_request_title || commitLine || name,
    commitSha: row.commit_sha,
    commitLine,
    workflow: row.workflow,
    runNumber: row.run_number,
    runId: row.run_id,
    uploadedAt: row.uploaded_at,
    fileSize: row.file_size,
  };
}

/** Every Public product with at least one Build, most recently active first. */
export async function loadIndex(db: D1Database): Promise<ProductSummary[]> {
  const { results } = await db.prepare("SELECT application_id, repository, repository_visibility FROM products").all<ProductRow>();
  const products = await Promise.all(
    results.filter((row) => isPublicProduct(row.application_id, row.repository_visibility)).map((row) => loadProduct(db, row)),
  );
  return products.filter((product): product is ProductSummary => product !== null).sort((a, b) => b.lastUploadAt - a.lastUploadAt);
}

export async function loadProductPage(db: D1Database, applicationId: string): Promise<ProductPageModel> {
  const row = await productRow(db, applicationId);
  if (!row) return { kind: "not_found" };
  if (!isPublicProduct(row.application_id, row.repository_visibility)) return { kind: "private" };
  const product = await loadProduct(db, row);
  return product ? { kind: "product", product } : { kind: "not_found" };
}

export async function loadChannelPage(db: D1Database, applicationId: string, channelName: string): Promise<ChannelPageModel> {
  const row = await productRow(db, applicationId);
  if (!row) return { kind: "not_found" };
  if (!isPublicProduct(row.application_id, row.repository_visibility)) return { kind: "private" };
  const channel = await db
    .prepare("SELECT id, name, is_default, pull_request, ended_at FROM channels WHERE application_id = ? AND name = ?")
    .bind(applicationId, channelName)
    .first<{ id: number; name: string; is_default: number; pull_request: number | null; ended_at: number | null }>();
  if (!channel) return { kind: "not_found" };
  const product = (await loadProduct(db, row)) ?? emptyProduct(row);
  const merged = channel.pull_request !== null && (await mergedPullRequests(db, applicationId)).has(channel.pull_request);

  const { results } = await db
    .prepare(`SELECT ${BUILD_COLUMNS} FROM builds b WHERE b.channel_id = ? AND b.deleted_at IS NULL ORDER BY b.run_id DESC, b.uploaded_at DESC`)
    .bind(channel.id)
    .all<BuildRow>();
  if (results.length === 0) {
    if (channel.ended_at === null) return { kind: "not_found" };
    const title = await db
      .prepare("SELECT pull_request_title FROM builds WHERE channel_id = ? ORDER BY run_id DESC LIMIT 1")
      .bind(channel.id)
      .first<{ pull_request_title: string | null }>();
    const fallback = product.channels.find((c) => c.isDefault);
    return {
      kind: "ended",
      product,
      channel: { name: channel.name, pullRequest: channel.pull_request, pullRequestTitle: title?.pull_request_title ?? null, endedAt: channel.ended_at, merged },
      next: fallback ? { channel: fallback.name, build: fallback.newest } : null,
    };
  }

  const builds: ChannelBuild[] = results.map((build, index) => ({
    ...summary(build, product.name),
    newest: index === 0,
    kept: keptUntil({
      applicationId,
      uploadedAt: build.uploaded_at,
      pullRequest: channel.pull_request !== null,
      channelEndedAt: channel.ended_at,
      newest: index === 0,
    }),
  }));
  return {
    kind: "channel",
    product,
    channel: {
      name: channel.name,
      isDefault: channel.is_default === 1,
      pullRequest: channel.pull_request,
      pullRequestTitle: results[0]!.pull_request_title,
      endedAt: channel.ended_at,
      merged,
      newest: builds[0]!,
      liveBuilds: builds.length,
    },
    builds,
  };
}

interface ProductRow {
  application_id: string;
  repository: string;
  repository_visibility: string;
}

function productRow(db: D1Database, applicationId: string): Promise<ProductRow | null> {
  return db.prepare("SELECT application_id, repository, repository_visibility FROM products WHERE application_id = ?").bind(applicationId).first<ProductRow>();
}

function emptyProduct(row: ProductRow): ProductSummary {
  return {
    applicationId: row.application_id,
    name: config.products?.[row.application_id]?.displayName ?? row.application_id,
    repository: row.repository,
    iconBuildId: null,
    channels: [],
    lastUploadAt: 0,
  };
}

/** A Product and each of its Channels that still has Builds, with that Channel's newest. */
async function loadProduct(db: D1Database, row: ProductRow): Promise<ProductSummary | null> {
  const { results } = await db
    .prepare(
      `SELECT * FROM (
         SELECT ${BUILD_COLUMNS}, c.name AS channel, c.is_default, c.pull_request, c.ended_at,
           COUNT(*) OVER (PARTITION BY c.id) AS live,
           ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY b.run_id DESC, b.uploaded_at DESC) AS position
         FROM channels c JOIN builds b ON b.channel_id = c.id AND b.deleted_at IS NULL
         WHERE c.application_id = ?)
       WHERE position = 1`,
    )
    .bind(row.application_id)
    .all<BuildRow & { channel: string; is_default: number; pull_request: number | null; ended_at: number | null; live: number }>();
  if (results.length === 0) return null;

  const latest = results.reduce((a, b) => (b.uploaded_at > a.uploaded_at ? b : a));
  const overrides = config.products?.[row.application_id];
  const name = overrides?.displayName ?? latest.label ?? row.application_id;
  const withIcon = overrides?.icon ? latest : results.filter((r) => r.icon_key).sort((a, b) => b.uploaded_at - a.uploaded_at)[0];
  const merged = await mergedPullRequests(db, row.application_id);

  const channels = results.map((r): ChannelSummary => ({
    name: r.channel,
    isDefault: r.is_default === 1,
    pullRequest: r.pull_request,
    pullRequestTitle: r.pull_request_title,
    endedAt: r.ended_at,
    merged: r.pull_request !== null && merged.has(r.pull_request),
    newest: summary(r, name),
    liveBuilds: r.live,
  }));
  // The default Channel first, then other named Channels by name, then pull requests: open ones by
  // newest activity, then ended ones.
  channels.sort((a, b) => order(a) - order(b) || compareWithin(a, b));
  return {
    applicationId: row.application_id,
    name,
    repository: row.repository,
    iconBuildId: withIcon?.id ?? null,
    channels,
    lastUploadAt: latest.uploaded_at,
  };
}

function order(channel: ChannelSummary): number {
  if (channel.isDefault) return 0;
  if (channel.pullRequest === null) return 1;
  return channel.endedAt === null ? 2 : 3;
}

function compareWithin(a: ChannelSummary, b: ChannelSummary): number {
  if (a.pullRequest === null) return a.name.localeCompare(b.name);
  return b.newest.uploadedAt - a.newest.uploadedAt;
}

async function mergedPullRequests(db: D1Database, applicationId: string): Promise<Set<number>> {
  const { results } = await db
    .prepare(
      `SELECT prc.pull_request FROM pull_request_comments prc JOIN products p ON p.repository_id = prc.repository_id
       WHERE p.application_id = ? AND prc.merged = 1`,
    )
    .bind(applicationId)
    .all<{ pull_request: number }>();
  return new Set(results.map((r) => r.pull_request));
}
