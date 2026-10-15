import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { unconfiguredAllowedRepositories } from "../../src/allowed-repositories";
import { newBuildId } from "../../src/ids";
import { replacementFor, resolveChannel } from "../../src/uploads";
import { createTestApp, fakeAllowList, sha256Hex, uniqueApplicationId, uploadRequest } from "./support";

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

async function post(t: TestApp, path: string, body: unknown, claims: Record<string, unknown> = {}) {
  const token = await t.issuer.sign(claims);
  return t.app.request(
    path,
    { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) },
    env,
  );
}

async function create(t: TestApp, body: unknown, claims: Record<string, unknown> = {}) {
  const response = await post(t, "/api/v1/uploads", body, claims);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function complete(t: TestApp, buildId: string, claims: Record<string, unknown> = {}) {
  const response = await post(t, `/api/v1/uploads/${buildId}/complete`, undefined, claims);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

const build = (id: string) => env.DB.prepare("SELECT * FROM builds WHERE id = ?").bind(id).first<Record<string, any>>();
const channels = (applicationId: string) =>
  env.DB.prepare("SELECT name, is_default, pull_request FROM channels WHERE application_id = ? ORDER BY name").bind(applicationId).all().then((r) => r.results);

let runs = 2_000_000_000;
const nextRun = () => String((runs += 1));

describe("POST /api/v1/uploads", () => {
  it("needs a token", async () => {
    const t = await createTestApp();
    const response = await t.app.request("/api/v1/uploads", { method: "POST", body: "{}" }, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "token_missing" });
  });

  it("refuses everything until the allow-list is configured", async () => {
    const t = await createTestApp({ allowedRepositories: unconfiguredAllowedRepositories });
    const { status, body } = await create(t, uploadRequest(uniqueApplicationId()));
    expect(status).toBe(403);
    expect(body.code).toBe("allow_list_not_configured");
  });

  it("refuses repositories the allow-list doesn't cover", async () => {
    const t = await createTestApp({
      allowedRepositories: fakeAllowList(() => ({ allowed: false, code: "repository_not_allowed", reason: "Not listed." })),
    });
    const { status, body } = await create(t, uploadRequest(uniqueApplicationId()));
    expect(status).toBe(403);
    expect(body).toEqual({ code: "repository_not_allowed", message: "Not listed." });
  });

  it.each(["pull_request_target", "workflow_run"])("refuses %s runs unless the repository allows them", async (event) => {
    const refused = await createTestApp();
    const claims = { event_name: event, run_id: nextRun() };
    expect((await create(refused, uploadRequest(uniqueApplicationId(), { channel: "fork-builds", defaultBranch: false }), claims)).body.code).toBe("event_not_allowed");

    const allowed = await createTestApp({ allowedRepositories: fakeAllowList(() => ({ allowed: true, allowEvents: [event as "workflow_run"] })) });
    expect((await create(allowed, uploadRequest(uniqueApplicationId(), { channel: "fork-builds", defaultBranch: false }), claims)).status).toBe(201);
  });

  it("validates the body", async () => {
    const t = await createTestApp();
    const { status, body } = await create(t, uploadRequest(uniqueApplicationId(), { signerSha256: "not-hex" }));
    expect(status).toBe(400);
    expect(body).toEqual({ code: "invalid_request", message: "signerSha256 has an invalid format." });
    expect((await create(t, { ...uploadRequest(uniqueApplicationId()), extra: 1 })).body.code).toBe("invalid_request");
  });

  it("creates a pending Build on the default Channel with presigned URLs", async () => {
    const t = await createTestApp();
    const applicationId = uniqueApplicationId();
    const iconSha = "c".repeat(64);
    const { status, body } = await create(t, uploadRequest(applicationId, { icon: { size: 10, sha256: iconSha, contentType: "image/png" } }), { run_id: nextRun() });

    expect(status).toBe(201);
    expect(body.buildId).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(body.buildUrl).toBe(`https://drop.example.com/b/${body.buildId}`);
    expect(body.expiresAt).toBe("2026-10-15T14:12:00.000Z");
    const apkUrl = new URL(body.apk.url);
    expect(apkUrl.host).toBe("test-account.r2.cloudflarestorage.com");
    expect(apkUrl.pathname).toBe(`/drop-builds/builds/${body.buildId}/1/app.apk`);
    expect(apkUrl.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(apkUrl.searchParams.get("X-Amz-SignedHeaders")).toContain("x-amz-checksum-sha256");
    expect(body.apk.headers).toEqual({ "x-amz-checksum-sha256": btoa(String.fromCharCode(...new Uint8Array(32).fill(0xbb))) });
    expect(new URL(body.icon.url).pathname).toBe(`/drop-builds/builds/${body.buildId}/1/icon.png`);

    expect(await build(body.buildId)).toMatchObject({
      application_id: applicationId,
      workflow: "Android",
      run_number: 1876,
      commit_sha: "9f3c2a1".padEnd(40, "0"),
      built_sha: "a".repeat(40),
      commit_message: "Cache map tiles",
      uploaded_at: null,
    });
    expect(await channels(applicationId)).toEqual([{ name: "main", is_default: 1, pull_request: null }]);
  });

  it("puts pull request runs on their own Pull request channel only", async () => {
    const t = await createTestApp();
    const applicationId = uniqueApplicationId();
    const pr = { channel: "pr/142", defaultBranch: false, pullRequestTitle: "Offline map tiles" };

    const wrong = await create(t, uploadRequest(applicationId, pr), { event_name: "pull_request", ref: "refs/pull/141/merge", run_id: nextRun() });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe("channel_ref_mismatch");

    const right = await create(t, uploadRequest(applicationId, pr), { event_name: "pull_request", ref: "refs/pull/142/merge", run_id: nextRun() });
    expect(right.status).toBe(201);
    expect(await channels(applicationId)).toEqual([{ name: "pr/142", is_default: 0, pull_request: 142 }]);
    expect((await build(right.body.buildId))!.pull_request_title).toBe("Offline map tiles");
  });

  it("refuses an upload to an ended Channel", async () => {
    const t = await createTestApp();
    const applicationId = uniqueApplicationId();
    const claims = { event_name: "pull_request", ref: "refs/pull/9/merge" };
    await create(t, uploadRequest(applicationId, { channel: "pr/9", defaultBranch: false }), { ...claims, run_id: nextRun() });
    await env.DB.prepare("UPDATE channels SET ended_at = 1 WHERE application_id = ?").bind(applicationId).run();

    const { status, body } = await create(t, uploadRequest(applicationId, { channel: "pr/9", defaultBranch: false }), { ...claims, run_id: nextRun() });
    expect(status).toBe(409);
    expect(body.code).toBe("channel_ended");
  });

  it("moves the default mark when a default-branch run names another Channel", async () => {
    const t = await createTestApp();
    const applicationId = uniqueApplicationId();
    await create(t, uploadRequest(applicationId), { run_id: nextRun() });
    await create(t, uploadRequest(applicationId, { channel: "trunk" }), { run_id: nextRun() });
    expect(await channels(applicationId)).toEqual([
      { name: "main", is_default: 0, pull_request: null },
      { name: "trunk", is_default: 1, pull_request: null },
    ]);
  });

  it("binds a Product to the first repository that uploads it", async () => {
    const t = await createTestApp();
    const applicationId = uniqueApplicationId();
    expect((await create(t, uploadRequest(applicationId), { run_id: nextRun() })).status).toBe(201);

    const { status, body } = await create(t, uploadRequest(applicationId), { repository: "someone/fork", repository_id: "9999", run_id: nextRun() });
    expect(status).toBe(403);
    expect(body.code).toBe("product_bound_to_other_repository");
  });

  describe("in a run that already uploaded the Product", () => {
    it("replaces a pending Build, keeping its ID", async () => {
      const t = await createTestApp();
      const applicationId = uniqueApplicationId();
      const claims = { run_id: nextRun() };
      const first = await create(t, uploadRequest(applicationId), claims);
      const retry = await create(t, uploadRequest(applicationId, { versionCode: 4128 }), claims);

      expect(retry.status).toBe(201);
      expect(retry.body.buildId).toBe(first.body.buildId);
      expect((await build(first.body.buildId))!.version_code).toBe(4128);
    });

    it("refuses another Build from the same attempt once confirmed", async () => {
      const t = await createTestApp();
      const applicationId = uniqueApplicationId();
      const claims = { run_id: nextRun() };
      const first = await create(t, uploadRequest(applicationId), claims);
      await env.DB.prepare("UPDATE builds SET uploaded_at = 1 WHERE id = ?").bind(first.body.buildId).run();

      const again = await create(t, uploadRequest(applicationId), claims);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe("build_exists_for_run");
    });

    it("replaces a confirmed Build with a later attempt, deleting the old files", async () => {
      const t = await createTestApp();
      const applicationId = uniqueApplicationId();
      const run = nextRun();
      const first = await create(t, uploadRequest(applicationId), { run_id: run });
      const oldKey = `builds/${first.body.buildId}/1/app.apk`;
      await env.BUILDS.put(oldKey, "old!");
      await env.DB.prepare("UPDATE builds SET uploaded_at = 1 WHERE id = ?").bind(first.body.buildId).run();

      const rerun = await create(t, uploadRequest(applicationId), { run_id: run, run_attempt: "2" });

      expect(rerun.status).toBe(201);
      expect(rerun.body.buildId).toBe(first.body.buildId);
      expect(await build(first.body.buildId)).toMatchObject({ run_attempt: 2, uploaded_at: null, file_key: `builds/${first.body.buildId}/2/app.apk` });
      await expect.poll(() => env.BUILDS.head(oldKey)).toBeNull();
    });
  });
});

describe("POST /api/v1/uploads/{id}/complete", () => {
  const apkBytes = new TextEncoder().encode("apk!");

  async function pending(t: TestApp, overrides: Record<string, unknown> = {}) {
    const applicationId = uniqueApplicationId();
    const run = nextRun();
    const sha256 = await sha256Hex(apkBytes);
    const { body } = await create(t, uploadRequest(applicationId, { apk: { size: apkBytes.length, sha256 }, ...overrides }), { run_id: run });
    return { buildId: body.buildId as string, run, sha256, key: `builds/${body.buildId}/1/app.apk` };
  }

  it("confirms the Build once its APK is uploaded, and again without change", async () => {
    const t = await createTestApp();
    const p = await pending(t);
    await env.BUILDS.put(p.key, apkBytes, { sha256: p.sha256 });

    const done = await complete(t, p.buildId, { run_id: p.run });
    expect(done).toEqual({ status: 200, body: { buildId: p.buildId, buildUrl: `https://drop.example.com/b/${p.buildId}` } });
    const uploadedAt = (await build(p.buildId))!.uploaded_at;
    expect(uploadedAt).not.toBeNull();

    t.advance(1000);
    expect((await complete(t, p.buildId, { run_id: p.run })).status).toBe(200);
    expect((await build(p.buildId))!.uploaded_at).toBe(uploadedAt);
  });

  it("accepts on size alone when storage reports no checksum", async () => {
    const t = await createTestApp();
    const p = await pending(t);
    await env.BUILDS.put(p.key, apkBytes);
    expect((await complete(t, p.buildId, { run_id: p.run })).status).toBe(200);
  });

  it("drops an icon that was never uploaded", async () => {
    const t = await createTestApp();
    const p = await pending(t, { icon: { size: 3, sha256: "c".repeat(64), contentType: "image/webp" } });
    await env.BUILDS.put(p.key, apkBytes);
    await complete(t, p.buildId, { run_id: p.run });
    expect((await build(p.buildId))!.icon_key).toBeNull();
  });

  it("refuses when the APK is missing", async () => {
    const t = await createTestApp();
    const p = await pending(t);
    expect((await complete(t, p.buildId, { run_id: p.run })).body.code).toBe("file_missing");
  });

  it("refuses and deletes an APK of the wrong size", async () => {
    const t = await createTestApp();
    const p = await pending(t);
    await env.BUILDS.put(p.key, "too long!");
    expect((await complete(t, p.buildId, { run_id: p.run })).body.code).toBe("file_size_mismatch");
    expect(await env.BUILDS.head(p.key)).toBeNull();
  });

  it("refuses an APK whose stored checksum doesn't match", async () => {
    const t = await createTestApp();
    const p = await pending(t);
    const other = new TextEncoder().encode("evil");
    await env.BUILDS.put(p.key, other, { sha256: await sha256Hex(other) });
    expect((await complete(t, p.buildId, { run_id: p.run })).body.code).toBe("file_checksum_mismatch");
    expect((await build(p.buildId))!.uploaded_at).toBeNull();
  });

  it("refuses a token from another run attempt", async () => {
    const t = await createTestApp();
    const p = await pending(t);
    await env.BUILDS.put(p.key, apkBytes);
    const { status, body } = await complete(t, p.buildId, { run_id: p.run, run_attempt: "2" });
    expect(status).toBe(403);
    expect(body.code).toBe("build_run_mismatch");
  });

  it("answers not found for unknown Builds", async () => {
    const t = await createTestApp();
    expect((await complete(t, "Zz9Zz9Zz")).body.code).toBe("build_not_found");
    expect((await complete(t, "bad")).status).toBe(404);
  });
});

describe("resolveChannel", () => {
  const push = { ref: "refs/heads/main", eventName: "push" };

  it("refuses malformed names", () => {
    for (const channel of ["a//b", "release/", "pr/", "pr/0", "pr/abc"]) {
      expect(() => resolveChannel({ channel, defaultBranch: false }, push)).toThrowError(expect.objectContaining({ code: "channel_invalid" }));
    }
  });

  it("only lets default-branch events claim the default Channel", () => {
    expect(resolveChannel({ channel: "main", defaultBranch: true }, push)).toEqual({ name: "main", pullRequest: null, isDefault: true });
    expect(resolveChannel({ channel: "main", defaultBranch: true }, { ref: "refs/heads/main", eventName: "schedule" }).isDefault).toBe(true);
    expect(() => resolveChannel({ channel: "main", defaultBranch: true }, { ref: "refs/pull/1/merge", eventName: "pull_request" })).toThrowError(
      expect.objectContaining({ code: "default_branch_ref_invalid" }),
    );
    expect(() => resolveChannel({ channel: "main", defaultBranch: true }, { ref: "refs/tags/v1", eventName: "push" })).toThrowError(
      expect.objectContaining({ code: "default_branch_ref_invalid" }),
    );
  });

  it("lets other runs name any other Channel", () => {
    expect(resolveChannel({ channel: "release/2.8", defaultBranch: false }, { ref: "refs/tags/v2.8.0", eventName: "push" })).toEqual({
      name: "release/2.8",
      pullRequest: null,
      isDefault: false,
    });
  });
});

describe("replacementFor", () => {
  it("follows ADR 0013", () => {
    expect(replacementFor(null, 1)).toBe("insert");
    expect(replacementFor({ runAttempt: 3, confirmed: false }, 1)).toBe("replace");
    expect(replacementFor({ runAttempt: 1, confirmed: true }, 2)).toBe("replace");
    expect(replacementFor({ runAttempt: 2, confirmed: true }, 2)).toBe("reject");
    expect(replacementFor({ runAttempt: 2, confirmed: true }, 1)).toBe("reject");
  });
});

describe("newBuildId", () => {
  it("is 8 base62 characters", () => {
    const ids = new Set(Array.from({ length: 200 }, newBuildId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9A-Za-z]{8}$/);
  });
});
