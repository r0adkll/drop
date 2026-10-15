import { env } from "cloudflare:workers";
import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { createTestApp, seedBuild } from "./support";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

describe("GET /b/{buildId}/qr.svg", () => {
  it("draws the Build page URL with a quiet zone and caches forever", async () => {
    const { app } = await createTestApp();
    const build = await seedBuild();
    const response = await app.request(`/b/${build.id}/qr.svg`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const svg = await response.text();
    const { size } = encode(`https://drop.example.com/b/${build.id}`, { ecc: "M", border: 4 });
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`);
    const origins = [...svg.matchAll(/M(\d+) (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(origins.length).toBeGreaterThan(0);
    expect(origins.every(([x, y]) => x! >= 4 && y! >= 4 && x! < size - 4 && y! < size - 4)).toBe(true);
  });

  it("still draws an expired Build's code", async () => {
    const { app } = await createTestApp();
    const build = await seedBuild({ deletedAt: 1 });
    expect((await app.request(`/b/${build.id}/qr.svg`, {}, env)).status).toBe(200);
  });

  it("answers 404 for an unknown Build", async () => {
    const { app } = await createTestApp();
    expect((await app.request("/b/Zz9Zz9Zz/qr.svg", {}, env)).status).toBe(404);
    expect((await app.request("/b/nope/qr.svg", {}, env)).status).toBe(404);
  });
});

describe("GET /b/{buildId}/icon", () => {
  it("serves the icon, kept after the Build expires", async () => {
    const { app } = await createTestApp();
    const build = await seedBuild({ iconKey: "builds/icon-test/1/icon.png", deletedAt: 1 });
    await env.BUILDS.put("builds/icon-test/1/icon.png", PNG);
    const response = await app.request(`/b/${build.id}/icon`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it("answers 404 without an icon or a Build", async () => {
    const { app } = await createTestApp();
    const build = await seedBuild();
    expect((await app.request(`/b/${build.id}/icon`, {}, env)).status).toBe(404);
    expect((await app.request("/b/Zz9Zz9Zz/icon", {}, env)).status).toBe(404);
  });
});
