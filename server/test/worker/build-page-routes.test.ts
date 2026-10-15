import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { contentDisposition, parseRange } from "../../src/download";
import { NOW, createTestApp, seedBuild } from "./support";

const APK = new Uint8Array(Array.from({ length: 10 }, (_, i) => i + 1));

async function seedWithFile(options: Parameters<typeof seedBuild>[0] = {}) {
  const build = await seedBuild(options);
  await env.BUILDS.put(`builds/${build.id}/1/app.apk`, APK);
  return build;
}

describe("GET /b/{buildId}", () => {
  it("serves the page with a strict policy, link previews and a short cache", async () => {
    const { app } = await createTestApp();
    const build = await seedBuild({ channel: "pr/142", iconKey: "builds/x/1/icon.png" });
    const response = await app.request(`/b/${build.id}`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("img-src 'self' data:");
    const html = await response.text();
    expect(html).toContain(`<meta property="og:image" content="https://drop.example.com/b/${build.id}/icon">`);
    expect(html).toContain("Newest on pr/142");
  });

  it("marks an older Build as superseded by the Channel's newest", async () => {
    const { app } = await createTestApp();
    const older = await seedBuild({ channel: "pr/7", runId: 100 });
    const newer = await seedBuild({ applicationId: older.applicationId, channel: "pr/7", runId: 200 });
    const html = await (await app.request(`/b/${older.id}`, {}, env)).text();
    expect(html).toContain("A newer Build is on pr/7");
    expect(html).toContain(`href="/b/${newer.id}">Open the newest Build</a>`);
  });

  it("shows an expired Build on an ended Channel the default Channel's newest", async () => {
    const { app } = await createTestApp();
    const main = await seedBuild({ channel: "main", runId: 300 });
    const expired = await seedBuild({ applicationId: main.applicationId, channel: "pr/9", runId: 250, deletedAt: NOW });
    await env.DB.prepare("UPDATE channels SET ended_at = ? WHERE id = ?").bind(NOW - 86_400_000, expired.channelId).run();
    const html = await (await app.request(`/b/${expired.id}`, {}, env)).text();
    expect(html).toContain("This Build has expired");
    expect(html).toContain("Newest on main");
    expect(html).toContain(`href="/b/${main.id}">Open its Build page</a>`);
  });

  it("serves a Private product's Build only as a sign-in placeholder", async () => {
    const { app } = await createTestApp();
    const build = await seedBuild();
    await env.DB.prepare("UPDATE products SET repository_visibility = 'private' WHERE application_id = ?").bind(build.applicationId).run();
    const response = await app.request(`/b/${build.id}`, {}, env);
    expect(response.status).toBe(403);
    const html = await response.text();
    expect(html).toContain("This Build needs sign-in");
    expect(html).not.toContain("Trailhead");
  });

  it("answers an unknown or malformed ID with the not-found page", async () => {
    const { app } = await createTestApp();
    for (const id of ["Zz9Zz9Zz", "nope"]) {
      const response = await app.request(`/b/${id}`, {}, env);
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("No Build here");
    }
  });
});

describe("GET /b/{buildId}/download", () => {
  it("streams the APK as an attachment that can be resumed", async () => {
    const { app } = await createTestApp();
    const build = await seedWithFile({ label: "Trailhead", versionName: "2.8.0", versionCode: 4127 });
    const response = await app.request(`/b/${build.id}/download`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="Trailhead-2.8.0-4127.apk"; filename*=UTF-8''Trailhead-2.8.0-4127.apk`);
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("etag")).toBeTruthy();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(APK);
  });

  it("serves byte ranges, and the whole file again once it has changed", async () => {
    const { app } = await createTestApp();
    const build = await seedWithFile();
    const url = `/b/${build.id}/download`;

    const partial = await app.request(url, { headers: { range: "bytes=4-" } }, env);
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 4-9/10");
    expect(partial.headers.get("content-length")).toBe("6");
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(APK.slice(4));

    const suffix = await app.request(url, { headers: { range: "bytes=-3" } }, env);
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(APK.slice(7));

    const beyond = await app.request(url, { headers: { range: "bytes=10-" } }, env);
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe("bytes */10");

    const stale = await app.request(url, { headers: { range: "bytes=4-", "if-range": '"some-older-etag"' } }, env);
    expect(stale.status).toBe(200);
    expect(stale.headers.get("content-length")).toBe("10");
    await stale.arrayBuffer();
  });

  it("answers HEAD with the headers only", async () => {
    const { app } = await createTestApp();
    const build = await seedWithFile();
    const response = await app.request(`/b/${build.id}/download`, { method: "HEAD" }, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("10");
    expect(await response.text()).toBe("");
  });

  it("refuses expired, private and unknown Builds", async () => {
    const { app } = await createTestApp();
    const expired = await seedWithFile({ deletedAt: NOW });
    expect((await app.request(`/b/${expired.id}/download`, {}, env)).status).toBe(404);
    const hidden = await seedWithFile();
    await env.DB.prepare("UPDATE products SET repository_visibility = 'internal' WHERE application_id = ?").bind(hidden.applicationId).run();
    expect((await app.request(`/b/${hidden.id}/download`, {}, env)).status).toBe(404);
    expect((await app.request("/b/Zz9Zz9Zz/download", {}, env)).status).toBe(404);
  });
});

describe("download helpers", () => {
  it("parses single byte ranges and ignores what it can't serve", () => {
    expect(parseRange("bytes=0-4", 10)).toEqual({ offset: 0, length: 5 });
    expect(parseRange("bytes=5-", 10)).toEqual({ offset: 5, length: 5 });
    expect(parseRange("bytes=8-100", 10)).toEqual({ offset: 8, length: 2 });
    expect(parseRange("bytes=-4", 10)).toEqual({ offset: 6, length: 4 });
    expect(parseRange("bytes=-40", 10)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,4-5", 10)).toBeUndefined();
    expect(parseRange("bytes=5-2", 10)).toBeUndefined();
    expect(parseRange("items=0-1", 10)).toBeUndefined();
    expect(parseRange(undefined, 10)).toBeUndefined();
  });

  it("names the file in ASCII with a UTF-8 original", () => {
    expect(contentDisposition("Trailhead Admin", "1.3.0", 212)).toBe(`attachment; filename="Trailhead-Admin-1.3.0-212.apk"; filename*=UTF-8''Trailhead%20Admin-1.3.0-212.apk`);
    expect(contentDisposition("Café", null, 7)).toBe(`attachment; filename="Cafe-7.apk"; filename*=UTF-8''Caf%C3%A9-7.apk`);
    expect(contentDisposition('a"b', "1", 2)).toContain('filename="a-b-1-2.apk"');
  });
});
