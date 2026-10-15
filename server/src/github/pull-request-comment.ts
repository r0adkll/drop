// The App's one comment per pull request, edited in place: a block per Product with its newest
// Build, and a note once the pull request closes (docs/design.md#pull-request-comments).

import { closedPullRequestHours } from "../config";
import { GitHubError, type GitHubApp } from "./client";

export const COMMENT_MARKER = "<!-- drop:pull-request-comment -->";
const DROP_REPOSITORY = "https://github.com/r0adkll/drop";
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
    parts.push(...sorted.map((build) => block(baseUrl, repository, build)));
    const latest = builds.reduce((a, b) => (b.uploadedAt > a.uploadedAt ? b : a));
    parts.push(`<sub>Updated at ${formatTime(latest.uploadedAt)} UTC by ${runLink(repository, latest)} · <a href="${DROP_REPOSITORY}">Drop</a></sub>`);
  }
  return `${parts.join("\n\n")}\n`;
}

function block(baseUrl: string, repository: string, build: CommentBuild): string {
  const page = `${baseUrl}/b/${build.id}`;
  const title = `${escape(name(build))} ${version(build)}`;
  const icon = build.hasIcon ? `<img src="${page}/icon" width="20" height="20" alt=""> ` : "";
  return [
    "<table><tr>",
    `<td><a href="${page}"><img src="${page}/qr.svg" width="128" height="128" alt="QR code for ${title}"></a></td>`,
    "<td>",
    `${icon}<b>${escape(name(build))}</b> ${version(build)}<br>`,
    `<code>${escape(build.channel)}</code> · commit <a href="https://github.com/${escapePath(repository)}/commit/${escape(build.commitSha)}">${escape(build.commitSha.slice(0, 7))}</a> · ${runLink(repository, build)}<br>`,
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
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\s*[\r\n]+\s*/g, " ");
}

const escapePath = (repository: string) => repository.split("/").map(encodeURIComponent).join("/");

function formatTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

function formatDate(at: number): string {
  const date = new Date(at);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} at ${formatTime(at)}`;
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
