import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createTestApp, NOW, seedBuild, uniqueApplicationId } from "./support";

const SIGNER = "3a".repeat(32);
const OTHER_SIGNER = "c4".repeat(32);

async function check(params: Record<string, string | number | undefined>) {
  const { app } = await createTestApp();
  const query = new URLSearchParams(
    Object.entries({ signer: SIGNER, versionCode: 4127, channel: "main", ...params })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  const response = await app.request(`/api/v1/update?${query}`, {}, env);
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}

describe("the Update check", () => {
  it("offers the newest Build with a higher run ID and the installed Signer", async () => {
    const applicationId = uniqueApplicationId();
    await seedBuild({ applicationId, runId: 100 });
    const newest = await seedBuild({
      applicationId,
      runId: 102,
      versionName: "2.9.0",
      versionCode: 4130,
      commitSha: "c27e9a4".padEnd(40, "0"),
      commitMessage: "Cache map tiles\n\nLonger body",
    });
    await seedBuild({ applicationId, runId: 101 });

    const { status, headers, body } = await check({ applicationId, runId: 100 });
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      status: "update",
      update: {
        buildId: newest.id,
        channel: "main",
        label: "Trailhead",
        versionName: "2.9.0",
        versionCode: 4130,
        uploadedAt: new Date(NOW).toISOString(),
        headline: "Cache map tiles",
        commitSha: "c27e9a4".padEnd(40, "0"),
        pullRequest: null,
        buildUrl: `https://drop.example.com/b/${newest.id}`,
        fileSize: 4,
        fileSha256: "b".repeat(64),
        downloadUrl: `https://drop.example.com/b/${newest.id}/download`,
        downloadUrlExpiresAt: new Date(NOW + 3_600_000).toISOString(),
      },
    });
  });

  it("is up to date on the newest run, on an empty Channel and on an unknown one", async () => {
    const applicationId = uniqueApplicationId();
    await seedBuild({ applicationId, runId: 100 });
    expect((await check({ applicationId, runId: 100 })).body).toEqual({ status: "up_to_date" });
    expect((await check({ applicationId, runId: 100, channel: "beta" })).body).toEqual({ status: "up_to_date" });
  });

  it("judges a Stamp by its run ID even when that run uploaded nothing", async () => {
    const applicationId = uniqueApplicationId();
    await seedBuild({ applicationId, runId: 100 });
    const later = await seedBuild({ applicationId, runId: 120 });
    expect((await check({ applicationId, runId: 110 })).body).toMatchObject({ status: "update", update: { buildId: later.id } });
    expect((await check({ applicationId, runId: 130 })).body).toEqual({ status: "up_to_date" });
  });

  it("treats every Build as newer for a Build with no Stamp", async () => {
    const applicationId = uniqueApplicationId();
    const only = await seedBuild({ applicationId, runId: 100 });
    expect((await check({ applicationId })).body).toMatchObject({ status: "update", update: { buildId: only.id } });
  });

  it("skips deleted Builds", async () => {
    const applicationId = uniqueApplicationId();
    const kept = await seedBuild({ applicationId, runId: 101 });
    await seedBuild({ applicationId, runId: 102, deletedAt: NOW });
    expect((await check({ applicationId, runId: 100 })).body).toMatchObject({ status: "update", update: { buildId: kept.id } });
  });

  it("flags an Update with a lower version code as needing a reinstall", async () => {
    const applicationId = uniqueApplicationId();
    await seedBuild({ applicationId, runId: 101, versionCode: 718 });
    expect((await check({ applicationId, runId: 100, versionCode: 13770 })).body).toMatchObject({
      status: "update",
      update: { versionCode: 718, requiresReinstall: "version_code" },
    });
  });

  it("offers only the installed Signer's Builds, and says when none is newer", async () => {
    const applicationId = uniqueApplicationId();
    const same = await seedBuild({ applicationId, runId: 101 });
    await seedBuild({ applicationId, runId: 102, signer: OTHER_SIGNER });
    expect((await check({ applicationId, runId: 100 })).body).toMatchObject({ status: "update", update: { buildId: same.id } });
    expect((await check({ applicationId, runId: 101 })).body).toMatchObject({ status: "reinstall_required", update: { requiresReinstall: "signer" } });
  });

  it("sends a Build on an ended Channel to the default Channel's newest Build, preferring its Signer", async () => {
    const applicationId = uniqueApplicationId();
    const main = await seedBuild({ applicationId, runId: 90 });
    await seedBuild({ applicationId, runId: 95, signer: OTHER_SIGNER });
    const pr = await seedBuild({ applicationId, channel: "pr/142", runId: 100, pullRequestTitle: "Offline map tiles" });
    await env.DB.prepare("UPDATE channels SET ended_at = ? WHERE id = ?").bind(NOW, pr.channelId).run();

    expect((await check({ applicationId, channel: "pr/142", runId: 100 })).body).toMatchObject({
      status: "channel_ended",
      update: { buildId: main.id, channel: "main" },
    });

    // With no Build of the installed Signer there, the newest is offered for a reinstall.
    const other = uniqueApplicationId();
    await seedBuild({ applicationId: other, runId: 90, signer: OTHER_SIGNER });
    const released = await seedBuild({ applicationId: other, runId: 91, signer: OTHER_SIGNER });
    const debug = await seedBuild({ applicationId: other, channel: "pr/1256", runId: 100 });
    await env.DB.prepare("UPDATE channels SET ended_at = ? WHERE id = ?").bind(NOW, debug.channelId).run();
    expect((await check({ applicationId: other, channel: "pr/1256", runId: 100 })).body).toMatchObject({
      status: "channel_ended",
      update: { buildId: released.id, requiresReinstall: "signer" },
    });

    const lonely = uniqueApplicationId();
    const ended = await seedBuild({ applicationId: lonely, channel: "pr/7", runId: 100 });
    await env.DB.prepare("UPDATE channels SET ended_at = ? WHERE id = ?").bind(NOW, ended.channelId).run();
    expect((await check({ applicationId: lonely, channel: "pr/7", runId: 100 })).body).toEqual({ status: "channel_ended", update: null });
  });

  it("uses the pull request title as a Pull request channel Build's headline", async () => {
    const applicationId = uniqueApplicationId();
    await seedBuild({ applicationId, channel: "pr/9", runId: 101, pullRequestTitle: "Offline map tiles", commitMessage: "WIP" });
    expect((await check({ applicationId, channel: "pr/9", runId: 100 })).body).toMatchObject({
      update: { headline: "Offline map tiles", pullRequest: 9, channel: "pr/9" },
    });
  });

  it("refuses unknown and Private products, and bad parameters", async () => {
    expect(await check({ applicationId: uniqueApplicationId() })).toMatchObject({ status: 404, body: { code: "product_not_found" } });

    const applicationId = uniqueApplicationId();
    await seedBuild({ applicationId, runId: 101 });
    await env.DB.prepare("UPDATE products SET repository_visibility = 'private' WHERE application_id = ?").bind(applicationId).run();
    const hidden = await check({ applicationId, runId: 100 });
    expect(hidden).toMatchObject({ status: 403, body: { code: "sign_in_required" } });
    expect(JSON.stringify(hidden.body)).not.toContain("Trailhead");

    expect(await check({ applicationId, signer: "nope" })).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    expect(await check({ applicationId, versionCode: undefined })).toMatchObject({ status: 400, body: { code: "invalid_request" } });
    expect(await check({ applicationId, runId: "-1" })).toMatchObject({ status: 400, body: { code: "invalid_request" } });
  });
});
