import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installationAllowedRepositories, type AllowList } from "../../src/allowed-repositories";
import { createTestApp, uniqueApplicationId, uploadRequest } from "./support";

const SECRET = "test-webhook-secret";

let ids = 7_000_000;
const nextId = () => (ids += 1);

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A listed Owner with its own IDs, so tests sharing the database don't collide. */
function owner(login = `owner-${nextId()}`) {
  const accountId = nextId();
  const installationId = nextId();
  const repo = (name: string) => ({ id: nextId(), full_name: `${login}/${name}` });
  const installation = (selection: "all" | "selected", suspendedAt: string | null = null) => ({
    id: installationId,
    account: { id: accountId, login },
    repository_selection: selection,
    suspended_at: suspendedAt,
  });
  return { login, accountId, installationId, repo, installation };
}

async function setup(allowList: AllowList) {
  return createTestApp({ allowList, allowedRepositories: (e) => installationAllowedRepositories(e.DB, allowList) });
}

type TestApp = Awaited<ReturnType<typeof setup>>;

async function deliver(t: TestApp, event: string, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  const response = await t.app.request(
    "/api/v1/github/webhook",
    {
      method: "POST",
      headers: { "x-github-event": event, "x-hub-signature-256": signature ?? `sha256=${await hmacHex(SECRET, body)}`, "content-type": "application/json" },
      body,
    },
    env,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function check(allowList: AllowList, ownerId: number, repository: { id: number; full_name: string }) {
  return installationAllowedRepositories(env.DB, allowList).check({ repository: repository.full_name, repositoryId: repository.id, repositoryOwnerId: ownerId });
}

const installationCount = (accountId: number) =>
  env.DB.prepare("SELECT COUNT(*) AS n FROM installations WHERE account_id = ?").bind(accountId).first<{ n: number }>().then((r) => r!.n);

afterEach(() => vi.restoreAllMocks());

describe("POST /api/v1/github/webhook", () => {
  it("refuses deliveries without a valid signature", async () => {
    const t = await setup({ owners: {} });
    expect((await deliver(t, "ping", {}, "")).status).toBe(401);
    expect((await deliver(t, "ping", {}, `sha256=${await hmacHex("wrong-secret", "{}")}`)).body).toMatchObject({ code: "webhook_signature_invalid" });
    expect(await deliver(t, "ping", { zen: "Keep it logically awesome." })).toEqual({ status: 200, body: { result: "ignored" } });
  });

  it("refuses a known event without an installation", async () => {
    const t = await setup({ owners: {} });
    const { status, body } = await deliver(t, "installation", { action: "created" });
    expect(status).toBe(400);
    expect(body.code).toBe("invalid_request");
  });

  it("records a listed Owner's installation on selected repositories", async () => {
    const o = owner();
    const allowList = { owners: { [o.login]: o.accountId } };
    const t = await setup(allowList);
    const app = o.repo("app");
    const other = o.repo("other");

    expect((await check(allowList, o.accountId, app)).allowed).toBe(false);
    expect((await deliver(t, "installation", { action: "created", installation: o.installation("selected"), repositories: [app] })).body).toEqual({ result: "applied" });

    expect(await check(allowList, o.accountId, app)).toEqual({ allowed: true, allowEvents: [] });
    expect(await check(allowList, o.accountId, other)).toMatchObject({ allowed: false, code: "repository_not_selected" });
  });

  it("allows every repository of an installation on all repositories", async () => {
    const o = owner();
    const allowList = { owners: { [o.login]: o.accountId } };
    const t = await setup(allowList);
    await deliver(t, "installation", { action: "created", installation: o.installation("all") });
    expect((await check(allowList, o.accountId, o.repo("anything"))).allowed).toBe(true);
  });

  it("ignores installations by accounts that aren't listed", async () => {
    const listed = owner();
    const stranger = owner();
    const t = await setup({ owners: { [listed.login]: listed.accountId } });
    expect((await deliver(t, "installation", { action: "created", installation: stranger.installation("all") })).body).toEqual({ result: "ignored" });
    expect(await installationCount(stranger.accountId)).toBe(0);
  });

  it("ignores, with a warning, a listed login whose ID isn't the locked one", async () => {
    const original = owner("trailhead-org");
    const squatter = owner("Trailhead-Org");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = await setup({ owners: { [original.login]: original.accountId } });

    expect((await deliver(t, "installation", { action: "created", installation: squatter.installation("all") })).body).toEqual({ result: "ignored" });
    expect(await installationCount(squatter.accountId)).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`locks trailhead-org as ID ${original.accountId}`));
  });

  it("follows repositories being added and removed, and the selection changing", async () => {
    const o = owner();
    const allowList = { owners: { [o.login]: o.accountId } };
    const t = await setup(allowList);
    const app = o.repo("app");
    const later = o.repo("later");
    await deliver(t, "installation", { action: "created", installation: o.installation("selected"), repositories: [app] });

    await deliver(t, "installation_repositories", {
      action: "added", installation: o.installation("selected"), repository_selection: "selected", repositories_added: [later], repositories_removed: [],
    });
    expect((await check(allowList, o.accountId, later)).allowed).toBe(true);

    await deliver(t, "installation_repositories", {
      action: "removed", installation: o.installation("selected"), repository_selection: "selected", repositories_added: [], repositories_removed: [app],
    });
    expect(await check(allowList, o.accountId, app)).toMatchObject({ allowed: false, code: "repository_not_selected" });

    await deliver(t, "installation_repositories", {
      action: "added", installation: o.installation("all"), repository_selection: "all", repositories_added: [], repositories_removed: [],
    });
    expect((await check(allowList, o.accountId, app)).allowed).toBe(true);
  });

  it("follows suspension and deletion", async () => {
    const o = owner();
    const allowList = { owners: { [o.login]: o.accountId } };
    const t = await setup(allowList);
    const app = o.repo("app");
    await deliver(t, "installation", { action: "created", installation: o.installation("all") });

    await deliver(t, "installation", { action: "suspend", installation: o.installation("all", "2026-10-15T14:02:00Z") });
    expect(await check(allowList, o.accountId, app)).toMatchObject({ allowed: false, code: "app_not_installed", reason: expect.stringContaining("suspended") });

    await deliver(t, "installation", { action: "unsuspend", installation: o.installation("all") });
    expect((await check(allowList, o.accountId, app)).allowed).toBe(true);

    expect((await deliver(t, "installation", { action: "new_permissions_accepted", installation: o.installation("all") })).body).toEqual({ result: "ignored" });

    await deliver(t, "installation", { action: "deleted", installation: o.installation("all") });
    expect(await check(allowList, o.accountId, app)).toMatchObject({ allowed: false, code: "app_not_installed" });
  });

  it("replaces an installation whose deletion was missed", async () => {
    const o = owner();
    const allowList = { owners: { [o.login]: o.accountId } };
    const t = await setup(allowList);
    await deliver(t, "installation", { action: "created", installation: o.installation("all") });
    const reinstalled = { ...o.installation("selected"), id: nextId() };
    const app = o.repo("app");

    await deliver(t, "installation", { action: "created", installation: reinstalled, repositories: [app] });
    expect(await installationCount(o.accountId)).toBe(1);
    expect((await check(allowList, o.accountId, app)).allowed).toBe(true);
    expect((await check(allowList, o.accountId, o.repo("other"))).allowed).toBe(false);
  });
});

describe("uploads through the installation allow-list", () => {
  const OWNER_ID = 2001;
  const REPOSITORY_ID = 1001;

  async function uploadAs(t: TestApp, claims: Record<string, unknown>) {
    const token = await t.issuer.sign({ run_id: String(nextId()), ...claims });
    const response = await t.app.request(
      "/api/v1/uploads",
      { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(uploadRequest(uniqueApplicationId(), { channel: "fork-builds", defaultBranch: false })) },
      env,
    );
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  }

  it("needs a listed Owner, the App installed, and the repository selected", async () => {
    const accountId = OWNER_ID;
    const allowList: AllowList = { owners: { "your-org": accountId }, exceptions: { "Your-Org/Trailhead": { allowEvents: ["workflow_run"] } } };
    const t = await setup(allowList);

    const unlisted = await uploadAs(t, { repository_owner_id: "424242" });
    expect(unlisted.status).toBe(403);
    expect(unlisted.body.code).toBe("owner_not_listed");

    expect((await uploadAs(t, {})).body.code).toBe("app_not_installed");

    const installation = { id: nextId(), account: { id: accountId, login: "your-org" }, repository_selection: "selected" };
    await deliver(t, "installation", { action: "created", installation, repositories: [{ id: nextId(), full_name: "your-org/other" }] });
    const notSelected = await uploadAs(t, {});
    expect(notSelected.body.code).toBe("repository_not_selected");
    expect(notSelected.body.message).toContain("Repository access");

    await deliver(t, "installation_repositories", {
      action: "added", installation, repository_selection: "selected",
      repositories_added: [{ id: REPOSITORY_ID, full_name: "your-org/trailhead" }], repositories_removed: [],
    });
    expect((await uploadAs(t, {})).status).toBe(201);

    // The exception, matched case-insensitively by name, allows workflow_run but not pull_request_target.
    expect((await uploadAs(t, { event_name: "workflow_run" })).status).toBe(201);
    expect((await uploadAs(t, { event_name: "pull_request_target" })).body.code).toBe("event_not_allowed");
  });
});
