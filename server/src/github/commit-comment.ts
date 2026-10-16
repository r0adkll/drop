// The App's comment on the commit of a Build outside a Pull request channel
// (docs/design.md#commit-comments). Post-only: creating needs Contents read, but editing needs
// Contents write, which the App never holds (ADR 0010).

import { config } from "../config";
import { buildDays } from "../retention";
import { GitHubError, type GitHubApp } from "./client";
import { buildBlock, DROP_REPOSITORY, escape, escapePath, type CommentBuild } from "./pull-request-comment";

export const COMMIT_COMMENT_MARKER = "<!-- drop:commit-comment -->";

/** The comment's Markdown: the pull request comment's block for one Build, and how long it is kept. */
export function renderCommitComment(baseUrl: string, repository: string, build: CommentBuild): string {
  const days = buildDays(build.applicationId);
  return [
    COMMIT_COMMENT_MARKER,
    "**Install from Drop.** Scan the code with your Android phone, or open its Build page.",
    buildBlock(baseUrl, repository, build, { commitLink: false }),
    `<sub>Builds on <code>${escape(build.channel)}</code> are kept ${days} ${days === 1 ? "day" : "days"} unless they’re the newest · <a href="${DROP_REPOSITORY}">Drop</a></sub>`,
  ].join("\n\n") + "\n";
}

export type CommitCommentOutcome = "posted" | "already_posted" | "pull_request" | "turned_off" | "not_permitted";

/**
 * Posts the comment for a confirmed Build, once. A row claims the Build first, so concurrent
 * completions post once; a failed post releases the claim, so a later attempt of the run can try
 * again.
 */
export async function postCommitComment(db: D1Database, github: GitHubApp, baseUrl: string, buildId: string, installationId: number, now: number): Promise<CommitCommentOutcome> {
  const row = await db
    .prepare(
      `SELECT b.id, b.application_id, b.label, b.version_name, b.version_code, c.name AS channel, c.pull_request, b.commit_sha,
         b.workflow, b.run_number, b.run_id, b.uploaded_at, b.icon_key IS NOT NULL AS has_icon, p.repository
       FROM builds b JOIN channels c ON c.id = b.channel_id JOIN products p ON p.application_id = b.application_id
       WHERE b.id = ?`,
    )
    .bind(buildId)
    .first<{
      id: string; application_id: string; label: string | null; version_name: string | null; version_code: number; channel: string;
      pull_request: number | null; commit_sha: string; workflow: string; run_number: number; run_id: number; uploaded_at: number;
      has_icon: number; repository: string;
    }>();
  if (!row) throw new Error(`There is no Build ${buildId}.`);
  if (row.pull_request !== null) return "pull_request";
  if (config.products?.[row.application_id]?.commitComments === false) return "turned_off";

  const claim = await db.prepare("INSERT INTO commit_comments (build_id, created_at) VALUES (?, ?) ON CONFLICT (build_id) DO NOTHING").bind(buildId, now).run();
  if (claim.meta.changes === 0) return "already_posted";

  const build: CommentBuild = {
    id: row.id,
    applicationId: row.application_id,
    label: config.products?.[row.application_id]?.displayName ?? row.label,
    versionName: row.version_name,
    versionCode: row.version_code,
    channel: row.channel,
    commitSha: row.commit_sha,
    workflow: row.workflow,
    runNumber: row.run_number,
    runId: row.run_id,
    uploadedAt: row.uploaded_at,
    hasIcon: row.has_icon === 1 || config.products?.[row.application_id]?.icon !== undefined,
  };
  try {
    const comment = await github.request<{ id: number }>(`/repos/${escapePath(row.repository)}/commits/${encodeURIComponent(row.commit_sha)}/comments`, {
      method: "POST",
      body: { body: renderCommitComment(baseUrl, row.repository, build) },
      installation: installationId,
    });
    await db.prepare("UPDATE commit_comments SET comment_id = ? WHERE build_id = ?").bind(comment.id, buildId).run();
    return "posted";
  } catch (error) {
    await db.prepare("DELETE FROM commit_comments WHERE build_id = ?").bind(buildId).run();
    // An installation that hasn't accepted Contents read yet gets 403 "Resource not accessible by integration".
    if (error instanceof GitHubError && error.status === 403) return "not_permitted";
    throw error;
  }
}
