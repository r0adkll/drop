import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../../src/config";
import { createTestApp, NOW, seedBuild, uniqueApplicationId } from "./support";

const DAY = 86_400_000;
let repositories = 7000;

async function get(path: string) {
  const { app } = await createTestApp();
  const response = await app.request(path, {}, env);
  return { status: response.status, headers: response.headers, html: await response.text() };
}

/** A Product with main, beta and two pull request Channels, one of them ended. */
async function seedTrailhead() {
  const applicationId = uniqueApplicationId();
  const repositoryId = (repositories += 1);
  const base = { applicationId, repositoryId, repository: "your-org/trailhead" };
  await seedBuild({ ...base, channel: "main", runId: 10, uploadedAt: NOW - 2 * DAY, commitMessage: "Older main" });
  const main = await seedBuild({ ...base, channel: "main", runId: 20, uploadedAt: NOW - DAY, versionCode: 4130, commitMessage: "Offline map tiles\n\nBody" });
  const beta = await seedBuild({ ...base, channel: "beta", runId: 15, uploadedAt: NOW - 3 * DAY, isDefault: false, commitMessage: "Release candidate" });
  const prOld = await seedBuild({ ...base, channel: "pr/151", runId: 30, uploadedAt: NOW - 2 * DAY, pullRequestTitle: "Trail difficulty filters", commitMessage: "First pass" });
  const prNew = await seedBuild({ ...base, channel: "pr/151", runId: 31, uploadedAt: NOW - 60_000, pullRequestTitle: "Trail difficulty filters", commitMessage: "Persist the filter" });
  const ended = await seedBuild({ ...base, channel: "pr/138", runId: 25, uploadedAt: NOW - DAY, pullRequestTitle: "Search trails by name" });
  await env.DB.prepare("UPDATE channels SET ended_at = ? WHERE id = ?").bind(NOW - 6 * 3_600_000, ended.channelId).run();
  await env.DB.prepare("INSERT INTO pull_request_comments (repository_id, pull_request, closed_at, merged) VALUES (?, 138, ?, 1)").bind(repositoryId, NOW - 6 * 3_600_000).run();
  return { applicationId, main, beta, prOld, prNew, ended };
}

describe("the index", () => {
  afterEach(() => {
    delete config.pages;
  });

  it("shows each Public product's newest default-Channel Build with its QR code, install link and Channels", async () => {
    const t = await seedTrailhead();
    const hidden = await seedBuild({ channel: "main" });
    await env.DB.prepare("UPDATE products SET repository_visibility = 'private' WHERE application_id = ?").bind(hidden.applicationId).run();
    const { status, headers, html } = await get("/");
    expect(status).toBe(200);
    expect(headers.get("x-robots-tag")).toBe("noindex");
    expect(headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("<h1>Apps</h1>");
    expect(html).toContain(`href="/p/${t.applicationId}"`);
    expect(html).toContain("<p class=\"label\">Newest on main</p>");
    expect(html).toContain("Offline map tiles");
    expect(html).toContain(`href="/b/${t.main.id}/download"`);
    expect(html).toContain('<div class="qr" role="img"');
    expect(html).toContain(`href="/p/${t.applicationId}/c/beta">beta</a>`);
    expect(html).toContain("2 pull requests");
    expect(html).not.toContain(hidden.applicationId);
  });

  it("can be turned off, leaving Channel pages reachable", async () => {
    const t = await seedTrailhead();
    config.pages = { index: false };
    expect((await get("/")).status).toBe(404);
    expect((await get(`/p/${t.applicationId}`)).status).toBe(404);
    expect((await get(`/p/${t.applicationId}/c/main`)).status).toBe(200);
  });
});

describe("the Product page", () => {
  it("lists Channels, then pull requests with ended ones last", async () => {
    const t = await seedTrailhead();
    const { status, html } = await get(`/p/${t.applicationId}`);
    expect(status).toBe(200);
    const order = ["main</a>", "Default channel", ">beta</a>", ">pr/151</a>", ">pr/138</a>"].map((s) => html.indexOf(s));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Trail difficulty filters");
    expect(html).toContain("Open · newest");
    expect(html).toMatch(/Merged <time [^>]*data-ago>.*<\/time> · its 1 Build is deleted/);
  });

  it("refuses Private and unknown products", async () => {
    const hidden = await seedBuild({ channel: "main" });
    await env.DB.prepare("UPDATE products SET repository_visibility = 'private' WHERE application_id = ?").bind(hidden.applicationId).run();
    const refused = await get(`/p/${hidden.applicationId}`);
    expect(refused.status).toBe(403);
    expect(refused.html).toContain("This app needs sign-in");
    expect(refused.html).not.toContain("Trailhead");
    expect((await get(`/p/${uniqueApplicationId()}`)).status).toBe(404);
  });
});

describe("the Channel page", () => {
  it("lists a pull request's Builds newest first, with one-tap install for the newest only", async () => {
    const t = await seedTrailhead();
    const { status, html } = await get(`/p/${t.applicationId}/c/pr/151`);
    expect(status).toBe(200);
    expect(html).toContain("<h1>Trail difficulty filters</h1>");
    expect(html).toContain("Pull request <a href=\"https://github.com/your-org/trailhead/pull/151\">#151</a> · open");
    expect(html.indexOf("Persist the filter")).toBeLessThan(html.indexOf("First pass"));
    expect(html).toContain('<span class="chip new">Newest</span>');
    expect(html).toContain(`href="/b/${t.prNew.id}/download">Install</a>`);
    expect(html).not.toContain(`href="/b/${t.prOld.id}/download"`);
    expect(html).toContain("kept while newest");
    expect(html).toMatch(/deleted <time [^>]*data-date>/);
  });

  it("explains an ended Channel whose Builds are gone and offers the default Channel", async () => {
    const t = await seedTrailhead();
    await env.DB.prepare("UPDATE builds SET deleted_at = ? WHERE id = ?").bind(NOW, t.ended.id).run();
    const { status, html } = await get(`/p/${t.applicationId}/c/pr/138`);
    expect(status).toBe(200);
    expect(html).toContain("This channel has ended");
    expect(html).toContain("<h1>Search trails by name</h1>");
    expect(html).toContain("Pull request #138 was merged on");
    expect(html).toContain(`href="/p/${t.applicationId}/c/main">Open main</a>`);
  });

  it("is a 404 for an unknown Channel and escapes what uploads control", async () => {
    const t = await seedTrailhead();
    expect((await get(`/p/${t.applicationId}/c/nope`)).status).toBe(404);
    const hostile = await seedBuild({ applicationId: t.applicationId, channel: "main", runId: 99, commitMessage: '<script>alert(1)</script>' });
    const { html } = await get(`/p/${t.applicationId}/c/main`);
    expect(html).toContain(hostile.id);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html.match(/<script>/g)).toHaveLength(1);
  });
});
