// The App's one comment per pull request, edited in place: a block per Product with its newest
// Build, and a note once the pull request closes (docs/design.md#pull-request-comments).

import { closedPullRequestHours } from "../config";
import { GitHubError, type GitHubApp } from "./client";

export const COMMENT_MARKER = "<!-- drop:pull-request-comment -->";
export const DROP_REPOSITORY = "https://github.com/r0adkll/drop";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface CommentBuild {
  id: string;
  applicationId: string;
  label: string | null;
  versionName: string | null;
  versionCode: number;
  channel: string;
  commitSha: string;
  workflow: string;
  runNumber: number;
  runId: number;
  uploadedAt: number;
  hasIcon: boolean;
}

export interface CommentClosed {
  merged: boolean;
  /** When the earliest of its Builds will be deleted. */
  deleteAt: number;
  /** The default Channel Testers will be offered, if the Products have one. */
  defaultChannel: string | null;
}

export interface CommentDeleted {
  /** When retention deleted the last of its Builds. */
  deletedAt: number;
  /** The default Channel Testers are offered, if the Products have one. */
  defaultChannel: string | null;
}

export interface CommentContent {
  /** The deployment's URL, such as https://drop.example.com. */
  baseUrl: string;
  /** owner/name, for commit and run links. */
  repository: string;
  builds: CommentBuild[];
  closed?: CommentClosed;
}

/** The comment's Markdown. Every value from an upload is escaped; nothing in it can add markup. */
export function renderPullRequestComment({ baseUrl, repository, builds, closed }: CommentContent): string {
  const parts = [COMMENT_MARKER];
  if (closed) {
    const offered = closed.defaultChannel ? `the newest Build on \`${closed.defaultChannel}\`` : "the newest Build on the default Channel";
    parts.push(
      `> [!NOTE]\n> This pull request was ${closed.merged ? "merged" : "closed"}, so its Builds will be deleted on ${formatDate(closed.deleteAt)} UTC. ` +
        `Testers who installed one will be offered ${offered}.`,
    );
  }
  if (builds.length > 0) {
    parts.push("**Install from Drop.** Scan a code with your Android phone, or open its Build page.");
    const sorted = [...builds].sort((a, b) => name(a).localeCompare(name(b)) || a.applicationId.localeCompare(b.applicationId));
    parts.push(...sorted.map((build) => buildBlock(baseUrl, repository, build)));
    const latest = builds.reduce((a, b) => (b.uploadedAt > a.uploadedAt ? b : a));
    parts.push(`<sub>Updated at ${formatTime(latest.uploadedAt)} UTC by ${runLink(repository, latest)} · <a href="${DROP_REPOSITORY}">Drop</a></sub>`);
  }
  return `${parts.join("\n\n")}\n`;
}

/** What the comment says once retention has deleted the closed pull request's Builds: the note alone. */
export function renderDeletedComment({ deletedAt, defaultChannel }: CommentDeleted): string {
  const offered = defaultChannel ? `the newest Build on \`${defaultChannel}\`` : "the newest Build on the default Channel";
  return `${COMMENT_MARKER}\n\n> [!NOTE]\n> This pull request’s Builds were deleted on ${formatDay(deletedAt)}. Testers who installed one are offered ${offered}.\n`;
}

/**
 * One Build's block: its QR code beside its name, version, Channel, commit and CI run. A commit
 * comment leaves out the commit, which it is already on.
 */
export function buildBlock(baseUrl: string, repository: string, build: CommentBuild, { commitLink = true } = {}): string {
  const page = `${baseUrl}/b/${build.id}`;
  const commit = commitLink
    ? ` · commit <a href="https://github.com/${escapePath(repository)}/commit/${escape(build.commitSha)}">${escape(build.commitSha.slice(0, 7))}</a>`
    : "";
  const title = `${escape(name(build))} ${version(build)}`;
  const icon = build.hasIcon ? `<img src="${page}/icon" width="20" height="20" alt=""> ` : "";
  return [
    "<table><tr>",
    `<td><a href="${page}"><img src="${page}/qr.svg" width="128" height="128" alt="QR code for ${title}"></a></td>`,
    "<td>",
    `${icon}<b>${escape(name(build))}</b> ${version(build)}<br>`,
    `<code>${escape(build.channel)}</code>${commit} · ${runLink(repository, build)}<br>`,
    "<br>",
    `<b><a href="${page}">Open Build page</a></b>`,
    "</td>",
    "</tr></table>",
  ].join("\n");
}

const name = (build: CommentBuild) => build.label ?? build.applicationId;
const version = (build: CommentBuild) => (build.versionName ? `${escape(build.versionName)} (${build.versionCode})` : `(${build.versionCode})`);
const runLink = (repository: string, build: CommentBuild) =>
  `<a href="https://github.com/${escapePath(repository)}/actions/runs/${build.runId}">${escape(build.workflow)} #${build.runNumber}</a>`;

/**
 * HTML-escapes a value. Inside GitHub's HTML blocks Markdown isn't parsed until a blank line, so
 * line breaks are flattened too.
 */
export function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\s*[\r\n]+\s*/g, " ");
}

export const escapePath = (repository: string) => repository.split("/").map(encodeURIComponent).join("/");

function formatTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function formatDay(at: number): string {
  const date = new Date(at);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function formatDate(at: number): string {
  return `${formatDay(at)} at ${formatTime(at)}`;
}

// ---------------------------------------------------------------------------------------------
// Keeping the comment current

export interface CommentTarget {
  repositoryId: number;
  /** owner/name as GitHub reports it now. */
  repository: string;
  pullRequest: number;
  installationId: number;
}

interface IssueComment {
  id: number;
  body?: string;
  user?: { type?: string } | null;
  performed_via_github_app?: { id: number } | null;
}

/** What the comment should say now, from D1. Undefined when there is nothing to say. */
export async function commentContent(db: D1Database, baseUrl: string, target: CommentTarget): Promise<CommentContent | undefined> {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.application_id, b.label, b.version_name, b.version_code, c.name AS channel, b.commit_sha, b.workflow,
         b.run_number, b.run_id, b.uploaded_at, b.icon_key IS NOT NULL AS has_icon
       FROM channels c
       JOIN products p ON p.application_id = c.application_id
       JOIN builds b ON b.id = (
         SELECT b2.id FROM builds b2 WHERE b2.channel_id = c.id AND b2.deleted_at IS NULL
         ORDER BY b2.run_id DESC, b2.uploaded_at DESC LIMIT 1)
       WHERE p.repository_id = ? AND c.pull_request = ?`,
    )
    .bind(target.repositoryId, target.pullRequest)
    .all<{
      id: string; application_id: string; label: string | null; version_name: string | null; version_code: number; channel: string;
      commit_sha: string; workflow: string; run_number: number; run_id: number; uploaded_at: number; has_icon: number;
    }>();
  const builds: CommentBuild[] = results.map((row) => ({
    id: row.id,
    applicationId: row.application_id,
    label: row.label,
    versionName: row.version_name,
    versionCode: row.version_code,
    channel: row.channel,
    commitSha: row.commit_sha,
    workflow: row.workflow,
    runNumber: row.run_number,
    runId: row.run_id,
    uploadedAt: row.uploaded_at,
    hasIcon: row.has_icon === 1,
  }));

  const state = await db
    .prepare("SELECT closed_at, merged FROM pull_request_comments WHERE repository_id = ? AND pull_request = ?")
    .bind(target.repositoryId, target.pullRequest)
    .first<{ closed_at: number | null; merged: number | null }>();
  let closed: CommentClosed | undefined;
  if (state?.closed_at != null && builds.length > 0) {
    const defaultChannel = await db
      .prepare(`SELECT name FROM channels WHERE is_default = 1 AND application_id IN (${builds.map(() => "?").join(", ")}) ORDER BY name LIMIT 1`)
      .bind(...builds.map((build) => build.applicationId))
      .first<{ name: string }>();
    closed = {
      merged: state.merged === 1,
      // Products can keep closed pull requests' Builds for different times; the note gives the first.
      deleteAt: Math.min(...builds.map((build) => state.closed_at! + closedPullRequestHours(build.applicationId) * 3600_000)),
      defaultChannel: defaultChannel?.name ?? null,
    };
  }
  if (builds.length === 0) return undefined;
  return { baseUrl, repository: target.repository, builds, closed };
}

/**
 * Creates or edits the comment so it shows what D1 holds now. Uploads finishing together can race,
 * so a write is repeated while the Builds changed underneath it, and duplicate comments from two
 * concurrent first posts are folded into the oldest.
 */
export async function updatePullRequestComment(db: D1Database, github: GitHubApp, baseUrl: string, target: CommentTarget): Promise<void> {
  let written: string | undefined;
  for (let round = 0; round < 3; round++) {
    const content = await commentContent(db, baseUrl, target);
    if (!content) return;
    const body = renderPullRequestComment(content);
    if (body === written) return;
    await writeComment(db, github, target, body);
    written = body;
  }
}

async function writeComment(db: D1Database, github: GitHubApp, target: CommentTarget, body: string): Promise<void> {
  const issue = `/repos/${escapePath(target.repository)}/issues`;
  const edit = (id: number) => github.request(`${issue}/comments/${id}`, { method: "PATCH", body: { body }, installation: target.installationId });
  const remember = (id: number) =>
    db
      .prepare(
        `INSERT INTO pull_request_comments (repository_id, pull_request, comment_id) VALUES (?, ?, ?)
         ON CONFLICT (repository_id, pull_request) DO UPDATE SET comment_id = excluded.comment_id`,
      )
      .bind(target.repositoryId, target.pullRequest, id)
      .run();
  const mine = async () =>
    (await github.list<IssueComment>(`${issue}/${target.pullRequest}/comments`, { installation: target.installationId }))
      .filter((comment) => comment.body?.startsWith(COMMENT_MARKER) && comment.user?.type === "Bot" && (comment.performed_via_github_app?.id ?? github.appId) === github.appId)
      .sort((a, b) => a.id - b.id);

  const stored = await db
    .prepare("SELECT comment_id FROM pull_request_comments WHERE repository_id = ? AND pull_request = ?")
    .bind(target.repositoryId, target.pullRequest)
    .first<{ comment_id: number | null }>();
  if (stored?.comment_id) {
    try {
      await edit(stored.comment_id);
      return;
    } catch (error) {
      // Deleted by someone: find or post it again.
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    }
  }

  const existing = (await mine())[0];
  if (existing) {
    await edit(existing.id);
    await remember(existing.id);
    return;
  }
  const created = await github.request<IssueComment>(`${issue}/${target.pullRequest}/comments`, { method: "POST", body: { body }, installation: target.installationId });
  const [kept, ...duplicates] = await mine();
  const keep = kept ?? created;
  for (const duplicate of duplicates) {
    await github.request(`${issue}/comments/${duplicate.id}`, { method: "DELETE", installation: target.installationId }).catch((error: unknown) => {
      if (!(error instanceof GitHubError && error.status === 404)) throw error;
    });
  }
  if (keep.id !== created.id) await edit(keep.id);
  await remember(keep.id);
}

// ---------------------------------------------------------------------------------------------
// After retention

/**
 * Edits each closed pull request's comment down to the deleted note once retention has deleted all
 * its Builds. The comment is only ever edited here, never posted: one deleted by hand stays deleted.
 * Returns how many comments were settled.
 */
export async function noteDeletedBuilds(db: D1Database, github: GitHubApp, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT prc.repository_id, prc.pull_request, prc.comment_id, MAX(b.deleted_at) AS deleted_at,
         MAX(p.repository) AS repository, json_group_array(DISTINCT p.application_id) AS application_ids
       FROM pull_request_comments prc
       JOIN products p ON p.repository_id = prc.repository_id
       JOIN channels c ON c.application_id = p.application_id AND c.pull_request = prc.pull_request
       JOIN builds b ON b.channel_id = c.id
       WHERE prc.closed_at IS NOT NULL AND prc.deleted_note_at IS NULL
       GROUP BY prc.repository_id, prc.pull_request
       HAVING COUNT(*) = COUNT(b.deleted_at)`,
    )
    .all<{ repository_id: number; pull_request: number; comment_id: number | null; deleted_at: number; repository: string; application_ids: string }>();

  let settled = 0;
  for (const row of results) {
    const done = () =>
      db
        .prepare("UPDATE pull_request_comments SET deleted_note_at = ? WHERE repository_id = ? AND pull_request = ?")
        .bind(now, row.repository_id, row.pull_request)
        .run();
    if (row.comment_id === null) {
      await done();
      settled += 1;
      continue;
    }
    const applicationIds = JSON.parse(row.application_ids) as string[];
    const defaultChannel = await db
      .prepare(`SELECT name FROM channels WHERE is_default = 1 AND application_id IN (${applicationIds.map(() => "?").join(", ")}) ORDER BY name LIMIT 1`)
      .bind(...applicationIds)
      .first<{ name: string }>();
    const body = renderDeletedComment({ deletedAt: row.deleted_at, defaultChannel: defaultChannel?.name ?? null });
    const repository = escapePath(row.repository);
    try {
      const installation = await github.request<{ id: number }>(`/repos/${repository}/installation`);
      await github.request(`/repos/${repository}/issues/comments/${row.comment_id}`, { method: "PATCH", body: { body }, installation: installation.id });
    } catch (error) {
      // Gone: the App was uninstalled from the repository, or the comment was deleted by hand.
      if (!(error instanceof GitHubError && error.status === 404)) {
        console.error(`Noting deleted Builds on ${row.repository}#${row.pull_request} failed:`, error);
        continue;
      }
    }
    await done();
    settled += 1;
  }
  return settled;
}
