import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config";
import { COMMIT_COMMENT_MARKER, postCommitComment, renderCommitComment } from "../../src/github/commit-comment";
import type { CommentBuild } from "../../src/github/pull-request-comment";
import { createFakeGitHub } from "./fake-github";
import { createTestApp, NOW, seedBuild, uniqueApplicationId, uploadRequest } from "./support";

const BASE = "https://drop.example.com";
const SHA = "c27e9a4".padEnd(40, "0");

describe("renderCommitComment", () => {
  it("shows the Build's block without a commit link, and how long it is kept", () => {
    const build: CommentBuild = {
      id: "Hc2pQ7ve",
      applicationId: "com.example.trailhead",
      label: "Trailhead",
      versionName: "2.8.0",
      versionCode: 4125,
      channel: "main",
      commitSha: SHA,
      workflow: "Android",
      runNumber: 1880,
      runId: 11384730000,
      uploadedAt: NOW,
      hasIcon: true,
    };
    expect(renderCommitComment(BASE, "your-org/trailhead", build)).toBe(
      `${COMMIT_COMMENT_MARKER}

**Install from Drop.** Scan the code with your Android phone, or open its Build page.

<table><tr>
<td><a href="https://drop.example.com/b/Hc2pQ7ve"><img src="https://drop.example.com/b/Hc2pQ7ve/qr.svg" width="128" height="128" alt="QR code for Trailhead 2.8.0 (4125)"></a></td>
<td>
<img src="https://drop.example.com/b/Hc2pQ7ve/icon" width="20" height="20" alt=""> <b>Trailhead</b> 2.8.0 (4125)<br>
<code>main</code> · <a href="https://github.com/your-org/trailhead/actions/runs/11384730000">Android #1880</a><br>
<br>
<b><a href="https://drop.example.com/b/Hc2pQ7ve">Open Build page</a></b>
</td>
</tr></table>

<sub>Builds on <code>main</code> are kept 30 days unless they’re the newest · <a href="https://github.com/r0adkll/drop">Drop</a></sub>
`,
    );
  });
});

describe("postCommitComment", () => {
  afterEach(() => {
    delete config.products;
  });

  async function scenario(options: { channel?: string } = {}) {
    const github = await createFakeGitHub();
    const build = await seedBuild({ channel: options.channel ?? "main", commitSha: SHA });
    const post = () => postCommitComment(env.DB, github.app(), BASE, build.id, 77, NOW);
    return { github, build, post, comments: () => github.state.commitComments.get(`your-org/trailhead@${SHA}`) ?? [] };
  }

  it("posts once per Build, as the installation", async () => {
    const s = await scenario();
    expect(await s.post()).toBe("posted");
    expect(s.comments()).toHaveLength(1);
    expect(s.comments()[0]!.body).toContain(`/b/${s.build.id}/qr.svg`);
    expect(s.github.callsTo("POST", /commits/)[0]!.authorization).toMatch(/^token tok-77-/);
    const row = await env.DB.prepare("SELECT comment_id FROM commit_comments WHERE build_id = ?").bind(s.build.id).first<{ comment_id: number }>();
    expect(row?.comment_id).toBe(s.comments()[0]!.id);

    expect(await s.post()).toBe("already_posted");
    expect(s.comments()).toHaveLength(1);
  });

  it("leaves Pull request channel Builds to the pull request comment", async () => {
    const s = await scenario({ channel: "pr/9" });
    expect(await s.post()).toBe("pull_request");
    expect(s.github.callsTo("POST", /commits/)).toHaveLength(0);
  });

  it("posts nothing for a Product that turned commit comments off", async () => {
    const s = await scenario();
    config.products = { [s.build.applicationId]: { commitComments: false } };
    expect(await s.post()).toBe("turned_off");
    expect(s.github.callsTo("POST", /commits/)).toHaveLength(0);
  });

  it("releases its claim when the installation hasn't accepted Contents read, so a later attempt can post", async () => {
    const s = await scenario();
    s.github.route("POST", /commits/, () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 }));
    expect(await s.post()).toBe("not_permitted");
    expect(await env.DB.prepare("SELECT 1 FROM commit_comments WHERE build_id = ?").bind(s.build.id).first()).toBeNull();
  });
});

describe("commit comments from uploads", () => {
  it("comments on the commit of a Build completed on the default Channel", async () => {
    const github = await createFakeGitHub();
    const t = await createTestApp({ github: () => github.app() });
    await env.DB.prepare(
      `INSERT INTO installations (id, account_id, account_login, repository_selection, created_at, updated_at) VALUES (4100, 2001, 'your-org', 'all', 0, 0)
       ON CONFLICT (account_id) DO UPDATE SET id = excluded.id`,
    ).run();
    const token = await t.issuer.sign({ sha: SHA, run_id: "11384799999" });
    const post = (path: string, body?: unknown) =>
      t.app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

    const created = await post("/api/v1/uploads", uploadRequest(uniqueApplicationId(), { commit: { sha: SHA, message: "Cache map tiles" } }));
    const { buildId } = (await created.json()) as { buildId: string };
    await env.BUILDS.put(`builds/${buildId}/1/app.apk`, new Uint8Array([1, 2, 3, 4]));
    expect((await post(`/api/v1/uploads/${buildId}/complete`)).status).toBe(200);

    await vi.waitFor(() => expect(github.state.commitComments.get(`your-org/trailhead@${SHA}`)?.[0]?.body).toContain(`/b/${buildId}`));
  });
});
