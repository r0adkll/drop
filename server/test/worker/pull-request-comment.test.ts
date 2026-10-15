import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { COMMENT_MARKER, renderPullRequestComment, updatePullRequestComment, type CommentBuild } from "../../src/github/pull-request-comment";
import { createFakeGitHub } from "./fake-github";
import { createTestApp, NOW, seedBuild, uniqueApplicationId, uploadRequest } from "./support";

const BASE = "https://drop.example.com";
const trailhead: CommentBuild = {
  id: "k7Qm2xPa",
  applicationId: "com.example.trailhead",
  label: "Trailhead",
  versionName: "2.8.0",
  versionCode: 4127,
  channel: "pr/142",
  commitSha: "9f3c2a1".padEnd(40, "0"),
  workflow: "Android",
  runNumber: 1876,
  runId: 11384729304,
  uploadedAt: NOW,
  hasIcon: true,
};

describe("renderPullRequestComment", () => {
  it("shows a block per Product", () => {
    expect(renderPullRequestComment({ baseUrl: BASE, repository: "your-org/trailhead", builds: [trailhead] })).toBe(
      `${COMMENT_MARKER}

**Install from Drop.** Scan a code with your Android phone, or open its Build page.

<table><tr>
<td><a href="https://drop.example.com/b/k7Qm2xPa"><img src="https://drop.example.com/b/k7Qm2xPa/qr.svg" width="128" height="128" alt="QR code for Trailhead 2.8.0 (4127)"></a></td>
<td>
<img src="https://drop.example.com/b/k7Qm2xPa/icon" width="20" height="20" alt=""> <b>Trailhead</b> 2.8.0 (4127)<br>
<code>pr/142</code> · commit <a href="https://github.com/your-org/trailhead/commit/9f3c2a1000000000000000000000000000000000">9f3c2a1</a> · <a href="https://github.com/your-org/trailhead/actions/runs/11384729304">Android #1876</a><br>
<br>
<b><a href="https://drop.example.com/b/k7Qm2xPa">Open Build page</a></b>
</td>
</tr></table>

<sub>Updated at 14:02 UTC by <a href="https://github.com/your-org/trailhead/actions/runs/11384729304">Android #1876</a> · <a href="https://github.com/r0adkll/drop">Drop</a></sub>
`,
    );
  });

  it("orders Products by name and credits the latest run", () => {
    const admin: CommentBuild = { ...trailhead, id: "Rt4wN8cZ", applicationId: "com.example.admin", label: "Admin", hasIcon: false, versionName: null, versionCode: 212, runNumber: 1877, runId: 11384729999, uploadedAt: NOW + 5 * 60_000 };
    const body = renderPullRequestComment({ baseUrl: BASE, repository: "your-org/trailhead", builds: [trailhead, admin] });
    expect(body.indexOf("<b>Admin</b> (212)")).toBeLessThan(body.indexOf("<b>Trailhead</b>"));
    expect(body).not.toContain("Rt4wN8cZ/icon");
    expect(body).toContain("<sub>Updated at 14:07 UTC by <a href=\"https://github.com/your-org/trailhead/actions/runs/11384729999\">Android #1877</a>");
  });

  it("escapes everything an upload controls", () => {
    const hostile: CommentBuild = { ...trailhead, label: '<img src=x onerror="alert(1)">\n\n**bold**', versionName: "1.0 & <b>", workflow: "CI'\"" };
    const body = renderPullRequestComment({ baseUrl: BASE, repository: "your-org/trailhead", builds: [hostile] });
    expect(body).toContain("<b>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; **bold**</b> 1.0 &amp; &lt;b&gt; (4127)");
    expect(body).toContain("CI&#39;&quot; #1876");
    expect(body).not.toContain("<img src=x");
  });

  it("notes when the closed pull request's Builds will be deleted", () => {
    const merged = renderPullRequestComment({ baseUrl: BASE, repository: "your-org/trailhead", builds: [trailhead], closed: { merged: true, deleteAt: Date.UTC(2026, 9, 16, 16, 30), defaultChannel: "main" } });
    expect(merged).toContain(
      `${COMMENT_MARKER}\n\n> [!NOTE]\n> This pull request was merged, so its Builds will be deleted on Oct 16 at 16:30 UTC. Testers who installed one will be offered the newest Build on \`main\`.\n\n**Install from Drop.**`,
    );
    const closed = renderPullRequestComment({ baseUrl: BASE, repository: "your-org/trailhead", builds: [trailhead], closed: { merged: false, deleteAt: NOW, defaultChannel: null } });
    expect(closed).toContain("This pull request was closed, so");
    expect(closed).toContain("offered the newest Build on the default Channel.");
  });
});

let numbers = 500;
const nextPullRequest = () => (numbers += 1);
let repositoryIds = 6_000_000;
const nextRepositoryId = () => (repositoryIds += 1);

describe("updatePullRequestComment", () => {
  async function scenario() {
    const github = await createFakeGitHub();
    const pullRequest = nextPullRequest();
    const repositoryId = nextRepositoryId();
    const target = { repositoryId, repository: "your-org/trailhead", pullRequest, installationId: 77 };
    const build = await seedBuild({ repositoryId, channel: `pr/${pullRequest}`, label: "Trailhead" });
    const comments = () => github.state.comments.get(`your-org/trailhead#${pullRequest}`) ?? [];
    return { github, target, build, comments, update: () => updatePullRequestComment(env.DB, github.app(), BASE, target) };
  }

  it("posts the comment once, then edits it in place", async () => {
    const s = await scenario();
    await s.update();
    expect(s.comments()).toHaveLength(1);
    expect(s.comments()[0]!.body).toContain(`/b/${s.build.id}/qr.svg`);

    const newer = await seedBuild({ applicationId: s.build.applicationId, repositoryId: s.target.repositoryId, channel: `pr/${s.target.pullRequest}`, runId: 11384729305 });
    await s.update();
    expect(s.comments()).toHaveLength(1);
    expect(s.comments()[0]!.body).toContain(`/b/${newer.id}/qr.svg`);
    expect(s.comments()[0]!.body).not.toContain(`/b/${s.build.id}/`);
    // The stored ID is used: no second listing of the pull request's comments.
    expect(s.github.callsTo("GET", /\/issues\/\d+\/comments$/)).toHaveLength(2);
    expect(s.github.callsTo("PATCH", /\/issues\/comments\/\d+$/)).toHaveLength(1);
  });

  it("reposts a comment someone deleted", async () => {
    const s = await scenario();
    await s.update();
    s.github.state.comments.set(`your-org/trailhead#${s.target.pullRequest}`, []);
    await s.update();
    expect(s.comments()).toHaveLength(1);
  });

  it("adopts its existing comment, ignoring look-alikes from people", async () => {
    const s = await scenario();
    s.github.state.comments.set(`your-org/trailhead#${s.target.pullRequest}`, [
      { id: 1, body: `${COMMENT_MARKER} copied by a person`, user: { login: "someone", type: "User" }, performed_via_github_app: null },
      { id: 2, body: `${COMMENT_MARKER} old`, user: { login: "drop-example[bot]", type: "Bot" }, performed_via_github_app: { id: s.github.appId } },
    ]);
    await s.update();
    expect(s.comments().map((c) => c.id)).toEqual([1, 2]);
    expect(s.comments()[1]!.body).toContain("Install from Drop");
    expect(s.comments()[0]!.body).toContain("copied by a person");
  });

  it("folds a duplicate posted by a concurrent upload into the oldest", async () => {
    const s = await scenario();
    // Another upload posts first, between this one's listing and its post.
    s.github.route("POST", /\/issues\/\d+\/comments$/, (call) => {
      const key = `your-org/trailhead#${s.target.pullRequest}`;
      expect(call.path).toBe(`/repos/your-org/trailhead/issues/${s.target.pullRequest}/comments`);
      const existing = s.github.state.comments.get(key) ?? [];
      const racer = { id: 100, body: `${COMMENT_MARKER} racer`, user: { login: "drop-example[bot]", type: "Bot" }, performed_via_github_app: { id: s.github.appId } };
      const ours = { id: 200, body: (call.body as { body: string }).body, user: racer.user, performed_via_github_app: racer.performed_via_github_app };
      s.github.state.comments.set(key, [...existing, racer, ours]);
      return Response.json(ours, { status: 201 });
    });
    await s.update();
    expect(s.comments().map((c) => c.id)).toEqual([100]);
    expect(s.comments()[0]!.body).toContain("Install from Drop");
  });
});

describe("pull request comments from uploads and webhooks", () => {
  const SECRET = "test-webhook-secret";
  const apk = new Uint8Array([1, 2, 3, 4]);

  async function setup() {
    const github = await createFakeGitHub();
    const t = await createTestApp({ github: () => github.app() });
    const repositoryId = nextRepositoryId();
    const pullRequest = nextPullRequest();
    const installationId = 3_000_000 + repositoryId;
    await env.DB.prepare(
      `INSERT INTO installations (id, account_id, account_login, repository_selection, created_at, updated_at) VALUES (?, 2001, 'your-org', 'all', 0, 0)
       ON CONFLICT (account_id) DO UPDATE SET id = excluded.id`,
    ).bind(installationId).run();
    const claims = { repository_id: String(repositoryId), event_name: "pull_request", ref: `refs/pull/${pullRequest}/merge`, run_id: String(nextRepositoryId()) };
    return { github, t, repositoryId, pullRequest, installationId, claims, comments: () => github.state.comments.get(`your-org/trailhead#${pullRequest}`) ?? [] };
  }

  async function post(s: Awaited<ReturnType<typeof setup>>, path: string, body: unknown) {
    const token = await s.t.issuer.sign(s.claims);
    return s.t.app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  }

  async function deliver(s: Awaited<ReturnType<typeof setup>>, payload: unknown) {
    const body = JSON.stringify(payload);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const response = await s.t.app.request(
      "/api/v1/github/webhook",
      { method: "POST", headers: { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${mac}`, "content-type": "application/json" }, body },
      env,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  const closedEvent = (s: Awaited<ReturnType<typeof setup>>, overrides: Record<string, unknown> = {}) => ({
    action: "closed",
    number: s.pullRequest,
    pull_request: { merged: true, closed_at: "2026-10-15T16:30:00Z" },
    repository: { id: s.repositoryId, full_name: "your-org/trailhead", owner: { id: 2001, login: "your-org" } },
    installation: { id: s.installationId },
    ...overrides,
  });

  async function uploadToPullRequest(s: Awaited<ReturnType<typeof setup>>, applicationId = uniqueApplicationId()) {
    const created = await post(s, "/api/v1/uploads", uploadRequest(applicationId, { channel: `pr/${s.pullRequest}`, defaultBranch: false, apk: { size: 4, sha256: "b".repeat(64) } }));
    const { buildId } = (await created.json()) as { buildId: string };
    await env.BUILDS.put(`builds/${buildId}/1/app.apk`, apk);
    expect((await post(s, `/api/v1/uploads/${buildId}/complete`, undefined)).status).toBe(200);
    return buildId;
  }

  it("announces a Build completed on a Pull request channel", async () => {
    const s = await setup();
    const buildId = await uploadToPullRequest(s);
    await vi.waitFor(() => expect(s.comments()[0]?.body).toContain(`/b/${buildId}/qr.svg`));
    expect(s.github.calls.at(-1)!.authorization).toBe(`token tok-${s.installationId}-1`);
  });

  it("ends the Channel and notes the deletion when the pull request closes", async () => {
    const s = await setup();
    const applicationId = uniqueApplicationId();
    await uploadToPullRequest(s, applicationId);
    await vi.waitFor(() => expect(s.comments()).toHaveLength(1));

    expect(await deliver(s, closedEvent(s))).toEqual({ status: 200, body: { result: "applied" } });
    const channel = await env.DB.prepare(
      "SELECT ended_at FROM channels WHERE pull_request = ? AND application_id IN (SELECT application_id FROM products WHERE repository_id = ?)",
    ).bind(s.pullRequest, s.repositoryId).first<{ ended_at: number }>();
    expect(channel?.ended_at).toBe(Date.parse("2026-10-15T16:30:00Z"));
    await vi.waitFor(() => expect(s.comments()[0]!.body).toContain("This pull request was merged, so its Builds will be deleted on Oct 16 at 16:30 UTC."));
    expect(s.comments()).toHaveLength(1);

    // Its Channel has ended, so further uploads to it are refused.
    s.claims.run_id = String(nextRepositoryId());
    const refused = await post(s, "/api/v1/uploads", uploadRequest(applicationId, { channel: `pr/${s.pullRequest}`, defaultBranch: false }));
    expect(await refused.json()).toMatchObject({ code: "channel_ended" });
  });

  it("ignores other actions, other accounts and pull requests without Builds", async () => {
    const s = await setup();
    await uploadToPullRequest(s);
    expect((await deliver(s, closedEvent(s, { action: "reopened" }))).body).toEqual({ result: "ignored" });
    expect((await deliver(s, closedEvent(s, { repository: { id: s.repositoryId, full_name: "x/y", owner: { id: 999, login: "stranger" } } }))).body).toEqual({ result: "ignored" });
    expect((await deliver(s, closedEvent(s, { number: nextPullRequest() }))).body).toEqual({ result: "ignored" });
    expect((await deliver(s, { action: "closed" })).status).toBe(400);
  });
});
