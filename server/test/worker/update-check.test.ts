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

  it("offers only Builds of the installed Form factor, mobile when it isn't sent", async () => {
    const applicationId = uniqueApplicationId();
    const phone = await seedBuild({ applicationId, runId: 101 });
    const watch = await seedBuild({ applicationId, runId: 102, formFactor: "wear", versionCode: 1 });
    expect((await check({ applicationId, runId: 100 })).body).toMatchObject({ status: "update", update: { buildId: phone.id } });
    expect((await check({ applicationId, runId: 100, formFactor: "mobile" })).body).toMatchObject({ update: { buildId: phone.id } });
    expect((await check({ applicationId, runId: 100, formFactor: "wear", versionCode: 1 })).body).toMatchObject({
      status: "update",
      update: { buildId: watch.id, versionCode: 1 },
    });
    expect((await check({ applicationId, runId: 102, formFactor: "wear" })).body).toEqual({ status: "up_to_date" });

    // An ended Channel offers the default Channel's newest Build of the same Form factor.
    const pr = await seedBuild({ applicationId, channel: "pr/9", runId: 103, formFactor: "wear" });
    await seedBuild({ applicationId, runId: 104 });
    await env.DB.prepare("UPDATE channels SET ended_at = ? WHERE id = ?").bind(NOW, pr.channelId).run();
    expect((await check({ applicationId, channel: "pr/9", runId: 103, formFactor: "wear" })).body).toMatchObject({
      status: "channel_ended",
      update: { buildId: watch.id },
    });

    const { status, body } = await check({ applicationId, formFactor: "tv" });
    expect(status).toBe(400);
    expect(body).toEqual({ code: "invalid_request", message: "formFactor must be one of mobile, wear." });
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

  it("leads with release notes ahead of the pull request title, the rest as whatsNew", async () => {
    const applicationId = uniqueApplicationId();
    await seedBuild({ applicationId, channel: "pr/9", runId: 101, pullRequestTitle: "Offline map tiles", releaseNotes: "Beta 2.9\n\n• Filters" });
    const { body } = await check({ applicationId, channel: "pr/9", runId: 100 });
    expect(body).toMatchObject({ update: { headline: "Beta 2.9", whatsNew: "• Filters" } });

    const plain = uniqueApplicationId();
    await seedBuild({ applicationId: plain, channel: "main", runId: 101, commitMessage: "Fix\n\nBody" });
    expect((await check({ applicationId: plain, channel: "main", runId: 100 })).body.update).not.toHaveProperty("whatsNew");
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

async function checkBuild(buildId: string, params: Record<string, string | number | undefined>) {
  const { app } = await createTestApp();
  const query = new URLSearchParams(
    Object.entries({ signer: SIGNER, versionCode: 4127, channel: "main", ...params })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  const response = await app.request(`/api/v1/builds/${buildId}/update?${query}`, {}, env);
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> };
}

describe("checking one Build for Open in App", () => {
  it("offers a newer Build on the installed Channel as an Update", async () => {
    const applicationId = uniqueApplicationId();
    const newer = await seedBuild({ applicationId, runId: 102, versionName: "2.9.0", versionCode: 4130 });
    const { status, headers, body } = await checkBuild(newer.id, { applicationId, runId: 100 });
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ status: "update", update: { buildId: newer.id, channel: "main", versionCode: 4130 } });
    expect(body.update.requiresReinstall).toBeUndefined();
    // Every Build counts as newer for a Build with no Stamp, as in the Update check.
    expect((await checkBuild(newer.id, { applicationId })).body).toMatchObject({ status: "update" });
  });

  it("offers a Build on another Channel, or an older one, to install", async () => {
    const applicationId = uniqueApplicationId();
    const pr = await seedBuild({ applicationId, channel: "pr/151", runId: 90, pullRequestTitle: "Trail difficulty filters" });
    expect((await checkBuild(pr.id, { applicationId, runId: 100 })).body).toMatchObject({
      status: "install",
      update: { buildId: pr.id, channel: "pr/151", pullRequest: 151, headline: "Trail difficulty filters" },
    });
    const older = await seedBuild({ applicationId, runId: 95 });
    expect((await checkBuild(older.id, { applicationId, runId: 100 })).body).toMatchObject({ status: "install", update: { buildId: older.id } });
  });

  it("flags a lower version code or another Signer as needing a reinstall", async () => {
    const applicationId = uniqueApplicationId();
    const lower = await seedBuild({ applicationId, channel: "beta", runId: 101, versionCode: 718 });
    expect((await checkBuild(lower.id, { applicationId, runId: 100 })).body).toMatchObject({
      status: "reinstall_required",
      update: { buildId: lower.id, requiresReinstall: "version_code" },
    });
    expect((await checkBuild(lower.id, { applicationId, runId: 100, signer: OTHER_SIGNER, versionCode: 1 })).body).toMatchObject({
      status: "reinstall_required",
      update: { requiresReinstall: "signer" },
    });
  });

  it("knows the installed Build, and describes an expired one", async () => {
    const applicationId = uniqueApplicationId();
    const installed = await seedBuild({ applicationId, channel: "pr/151", runId: 100 });
    expect((await checkBuild(installed.id, { applicationId, channel: "pr/151", runId: 100 })).body).toEqual({ status: "installed" });

    const expired = await seedBuild({ applicationId, channel: "pr/151", runId: 90, versionName: "2.7.0", versionCode: 4098, deletedAt: NOW - 3_600_000 });
    expect((await checkBuild(expired.id, { applicationId, runId: 100 })).body).toEqual({
      status: "expired",
      expired: {
        buildId: expired.id,
        channel: "pr/151",
        label: "Trailhead",
        versionName: "2.7.0",
        versionCode: 4098,
        deletedAt: new Date(NOW - 3_600_000).toISOString(),
        buildUrl: `https://drop.example.com/b/${expired.id}`,
      },
    });
  });

  it("answers only for a Build of the installed Product and Form factor", async () => {
    const applicationId = uniqueApplicationId();
    const phone = await seedBuild({ applicationId, runId: 101 });
    const watch = await seedBuild({ applicationId, runId: 101, formFactor: "wear" });
    expect((await checkBuild(phone.id, { applicationId: uniqueApplicationId(), runId: 100 })).body).toMatchObject({ code: "build_not_found" });
    expect((await checkBuild(watch.id, { applicationId, runId: 100 })).status).toBe(404);
    expect((await checkBuild(watch.id, { applicationId, runId: 100, formFactor: "wear" })).body).toMatchObject({ status: "update" });
    expect((await checkBuild("nope", { applicationId, runId: 100 })).status).toBe(404);
    expect((await checkBuild(phone.id, { applicationId, signer: "nope" })).status).toBe(400);

    await env.DB.prepare("UPDATE products SET repository_visibility = 'private' WHERE application_id = ?").bind(applicationId).run();
    const hidden = await checkBuild(phone.id, { applicationId, runId: 100 });
    expect(hidden).toMatchObject({ status: 403, body: { code: "sign_in_required" } });
    expect(JSON.stringify(hidden.body)).not.toContain("Trailhead");
  });
});
