import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { COMMENT_MARKER, noteDeletedBuilds } from "../../src/github/pull-request-comment";
import { runScheduled, type Dependencies } from "../../src/index";
import { ABANDONED_UPLOAD_MS, applyRetention } from "../../src/retention-job";
import { createFakeGitHub } from "./fake-github";
import { seedBuild, uniqueApplicationId } from "./support";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// Storage stamps objects with the real clock, so these tests run on it too, an hour or two ahead so
// objects put during the test are past the sweep's grace period.
const later = () => Date.now() + 2 * HOUR;

let repositories = 5000;
const uniqueRepositoryId = () => (repositories += 1);

async function deletedAt(id: string): Promise<number | null> {
  return (await env.DB.prepare("SELECT deleted_at FROM builds WHERE id = ?").bind(id).first<{ deleted_at: number | null }>())!.deleted_at;
}

async function endChannel(channelId: number, at: number): Promise<void> {
  await env.DB.prepare("UPDATE channels SET ended_at = ? WHERE id = ?").bind(at, channelId).run();
}

async function stored(key: string): Promise<boolean> {
  return (await env.BUILDS.head(key)) !== null;
}

describe("applyRetention", () => {
  it("keeps each open Channel's newest Build and expires the rest by age", async () => {
    const now = later();
    const applicationId = uniqueApplicationId();
    const old = await seedBuild({ applicationId, runId: 1, uploadedAt: now - 31 * DAY });
    const recent = await seedBuild({ applicationId, runId: 2, uploadedAt: now - 29 * DAY });
    const newest = await seedBuild({ applicationId, runId: 3, uploadedAt: now - 40 * DAY });
    const prOld = await seedBuild({ applicationId, channel: "pr/7", runId: 4, uploadedAt: now - 8 * DAY });
    const prNewest = await seedBuild({ applicationId, channel: "pr/7", runId: 5, uploadedAt: now - 9 * DAY });

    const result = await applyRetention(env.DB, env.BUILDS, now);

    expect(result.expiredBuilds.sort()).toEqual([old.id, prOld.id].sort());
    expect(await deletedAt(old.id)).toBe(now);
    expect(await deletedAt(prOld.id)).toBe(now);
    for (const kept of [recent, newest, prNewest]) expect(await deletedAt(kept.id)).toBeNull();
  });

  it("expires every Build of an ended Pull request channel 24 hours after it ends", async () => {
    const now = later();
    const applicationId = uniqueApplicationId();
    const a = await seedBuild({ applicationId, channel: "pr/8", runId: 1, uploadedAt: now - 2 * DAY });
    const b = await seedBuild({ applicationId, channel: "pr/8", runId: 2, uploadedAt: now - 2 * DAY });
    await endChannel(a.channelId, now - 23 * HOUR);
    expect((await applyRetention(env.DB, env.BUILDS, now)).expiredBuilds).not.toContain(b.id);

    await endChannel(a.channelId, now - 25 * HOUR);
    await applyRetention(env.DB, env.BUILDS, now);
    expect(await deletedAt(a.id)).toBe(now);
    expect(await deletedAt(b.id)).toBe(now);
  });

  it("deletes the files no Build or upload refers to, keeping icons and recent objects", async () => {
    const now = later();
    const applicationId = uniqueApplicationId();
    const expired = await seedBuild({ applicationId, runId: 1, uploadedAt: now - 31 * DAY, iconKey: "builds/EXPIRED1/1/icon.png" });
    const live = await seedBuild({ applicationId, runId: 2, uploadedAt: now });
    await env.DB
      .prepare(
        `INSERT INTO uploads (build_id, application_id, channel_id, run_id, run_attempt, workflow, run_number, event_name, ref,
           commit_sha, built_sha, version_code, signer_sha256, file_size, file_sha256, file_key, icon_key, created_at)
         VALUES ('UPLOAD01', ?, ?, 3, 1, 'Android', 1, 'push', 'refs/heads/main', 'a', 'a', 1, 'aa', 4, 'bb',
           'builds/UPLOAD01/1/app.apk', 'builds/UPLOAD01/1/icon.png', ?)`,
      )
      .bind(applicationId, live.channelId, now)
      .run();
    const keys = {
      expiredFile: `builds/${expired.id}/1/app.apk`,
      expiredIcon: "builds/EXPIRED1/1/icon.png",
      liveFile: `builds/${live.id}/1/app.apk`,
      uploadFile: "builds/UPLOAD01/1/app.apk",
      uploadIcon: "builds/UPLOAD01/1/icon.png",
      orphan: "builds/ORPHAN01/1/app.apk",
    };
    for (const key of Object.values(keys)) await env.BUILDS.put(key, "data");

    // Within the grace period nothing is swept, not even the orphan.
    await applyRetention(env.DB, env.BUILDS, Date.now());
    expect(await stored(keys.orphan)).toBe(true);

    const result = await applyRetention(env.DB, env.BUILDS, now);
    expect(result.deletedObjects).toBe(2);
    expect(await stored(keys.expiredFile)).toBe(false);
    expect(await stored(keys.orphan)).toBe(false);
    for (const key of [keys.expiredIcon, keys.liveFile, keys.uploadFile, keys.uploadIcon]) expect(await stored(key)).toBe(true);
  });

  it("drops uploads abandoned for a day", async () => {
    const now = later();
    const build = await seedBuild({ uploadedAt: now });
    const insert = (id: string, runId: number, createdAt: number) =>
      env.DB
        .prepare(
          `INSERT INTO uploads (build_id, application_id, channel_id, run_id, run_attempt, workflow, run_number, event_name, ref,
             commit_sha, built_sha, version_code, signer_sha256, file_size, file_sha256, file_key, created_at)
           VALUES (?, ?, ?, ?, 1, 'Android', 1, 'push', 'refs/heads/main', 'a', 'a', 1, 'aa', 4, 'bb', ?, ?)`,
        )
        .bind(id, build.applicationId, build.channelId, runId, `builds/${id}/1/app.apk`, createdAt)
        .run();
    await insert("ABANDON1", 101, now - ABANDONED_UPLOAD_MS);
    await insert("INFLIGT1", 102, now - ABANDONED_UPLOAD_MS + HOUR);

    expect((await applyRetention(env.DB, env.BUILDS, now)).abandonedUploads).toBe(1);
    const { results } = await env.DB.prepare("SELECT build_id FROM uploads WHERE application_id = ?").bind(build.applicationId).all<{ build_id: string }>();
    expect(results.map((row) => row.build_id)).toEqual(["INFLIGT1"]);
  });
});

describe("noteDeletedBuilds", () => {
  async function closedPullRequest(options: { deleteAll: boolean; commentId?: number | null }) {
    const now = later();
    const repositoryId = uniqueRepositoryId();
    const applicationId = uniqueApplicationId();
    await seedBuild({ applicationId, repositoryId, channel: "main", runId: 1 });
    const a = await seedBuild({ applicationId, repositoryId, channel: "pr/142", runId: 2, deletedAt: now - DAY });
    const b = await seedBuild({ applicationId, repositoryId, channel: "pr/142", runId: 3, deletedAt: options.deleteAll ? Date.UTC(2026, 9, 16, 16, 30) : null });
    await endChannel(a.channelId, now - 2 * DAY);
    const commentId = options.commentId === undefined ? 9_100_000 + repositoryId : options.commentId;
    await env.DB
      .prepare("INSERT INTO pull_request_comments (repository_id, pull_request, comment_id, closed_at, merged) VALUES (?, 142, ?, ?, 1)")
      .bind(repositoryId, commentId, now - 2 * DAY)
      .run();

    const github = await createFakeGitHub();
    github.state.comments.set("your-org/trailhead#142", [
      { id: 9_100_000 + repositoryId, body: `${COMMENT_MARKER}\n\nOld body`, user: { login: "drop[bot]", type: "Bot" }, performed_via_github_app: { id: github.appId } },
    ]);
    github.route("GET", /^\/repos\/your-org\/trailhead\/installation$/, () => Response.json({ id: 77 }));
    const noted = async () =>
      (await env.DB.prepare("SELECT deleted_note_at FROM pull_request_comments WHERE repository_id = ?").bind(repositoryId).first<{ deleted_note_at: number | null }>())!
        .deleted_note_at;
    return { now, github, noted, b };
  }

  it("edits the comment down to the deleted note once every Build is deleted, once", async () => {
    const { now, github, noted } = await closedPullRequest({ deleteAll: true });
    expect(await noteDeletedBuilds(env.DB, github.app(), now)).toBe(1);
    expect(github.state.comments.get("your-org/trailhead#142")![0]!.body).toBe(
      `${COMMENT_MARKER}\n\n> [!NOTE]\n> This pull request’s Builds were deleted on Oct 16. Testers who installed one are offered the newest Build on \`main\`.\n`,
    );
    expect(github.callsTo("PATCH", /issues\/comments/)[0]!.authorization).toMatch(/^token tok-77-/);
    expect(await noted()).toBe(now);

    expect(await noteDeletedBuilds(env.DB, github.app(), now)).toBe(0);
    expect(github.callsTo("PATCH", /issues\/comments/)).toHaveLength(1);
  });

  it("waits while any of the pull request's Builds remains", async () => {
    const { now, github, noted } = await closedPullRequest({ deleteAll: false });
    expect(await noteDeletedBuilds(env.DB, github.app(), now)).toBe(0);
    expect(github.callsTo("PATCH", /issues\/comments/)).toHaveLength(0);
    expect(await noted()).toBeNull();
  });

  it("settles without posting when the comment is gone", async () => {
    const { now, github, noted } = await closedPullRequest({ deleteAll: true, commentId: 1 });
    expect(await noteDeletedBuilds(env.DB, github.app(), now)).toBe(1);
    expect(github.callsTo("POST", /issues\/\d+\/comments/)).toHaveLength(0);
    expect(await noted()).toBe(now);
  });

  it("tries again next time after another failure", async () => {
    const { now, github, noted } = await closedPullRequest({ deleteAll: true });
    github.route("PATCH", /issues\/comments/, () => Response.json({ message: "Server Error" }, { status: 502 }));
    expect(await noteDeletedBuilds(env.DB, github.app(), now)).toBe(0);
    expect(await noted()).toBeNull();
  });
});

describe("runScheduled", () => {
  it("applies retention even without a GitHub App, then reports the missing App", async () => {
    const now = later();
    const old = await seedBuild({ runId: 1, uploadedAt: now - 31 * DAY });
    await seedBuild({ applicationId: old.applicationId, runId: 2, uploadedAt: now });
    const deps: Dependencies = {
      allowList: { owners: {} },
      allowedRepositories: () => ({ check: async () => ({ allowed: true as const, allowEvents: [] }) }),
      verifyToken: async () => {
        throw new Error("unused");
      },
      presigner: () => {
        throw new Error("unused");
      },
      github: () => undefined,
      now: () => now,
    };
    await expect(runScheduled(deps, env)).rejects.toThrow(/drop setup/);
    expect(await deletedAt(old.id)).toBe(now);
  });
});
