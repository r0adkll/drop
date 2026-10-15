import { env } from "cloudflare:workers";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { installationAllowedRepositories, type AllowList } from "../../src/allowed-repositories";
import { createGitHubApp, GitHubError, NO_APP, toPkcs8 } from "../../src/github/client";
import { claimResync, resyncInstallations } from "../../src/github/installations";
import { runScheduled, type Dependencies } from "../../src/index";
import { createFakeGitHub, type FakeGitHub } from "./fake-github";
import { createTestApp, NOW, uniqueApplicationId, uploadRequest } from "./support";

let ids = 8_000_000;
const nextId = () => (ids += 1);

function owner(login = `owner-${nextId()}`) {
  const accountId = nextId();
  const installationId = nextId();
  return {
    login,
    accountId,
    installationId,
    repo: (name: string) => ({ id: nextId(), full_name: `${login}/${name}` }),
    installation: (selection: "all" | "selected", suspendedAt: string | null = null) => ({
      id: installationId,
      account: { id: accountId, login },
      repository_selection: selection,
      suspended_at: suspendedAt,
    }),
  };
}

const installationRow = (id: number) =>
  env.DB.prepare("SELECT repository_selection, suspended_at FROM installations WHERE id = ?").bind(id).first<{ repository_selection: string; suspended_at: number | null }>();
const repositoryIds = (installationId: number) =>
  env.DB.prepare("SELECT repository_id FROM installation_repositories WHERE installation_id = ? ORDER BY repository_id")
    .bind(installationId)
    .all<{ repository_id: number }>()
    .then((r) => r.results.map((row) => row.repository_id));

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sync_state").run();
});

describe("GitHub App client", () => {
  let clock = NOW;
  let github: FakeGitHub;
  beforeEach(async () => {
    clock = NOW;
    github = await createFakeGitHub({ now: () => clock });
  });

  it("converts GitHub's PKCS#1 key to PKCS#8 for WebCrypto", () => {
    expect(toPkcs8(github.privateKeyPem)).toEqual(github.pkcs8);
    expect(toPkcs8(github.privateKeyPem.replace(/\n/g, "\\n"))).toEqual(github.pkcs8);
  });

  it("signs a short-lived, backdated App JWT and reuses it", async () => {
    const app = github.app();
    await app.request("/app/installations");
    await app.request("/app/installations");
    const [first, second] = github.calls;
    expect(first!.authorization).toBe(second!.authorization);
    const jwt = first!.authorization.replace(/^Bearer /, "");
    expect(decodeProtectedHeader(jwt)).toMatchObject({ alg: "RS256", typ: "JWT" });
    const { payload } = await jwtVerify(jwt, github.publicKey, { issuer: String(github.appId), currentDate: new Date(clock) });
    expect(payload.iat).toBe(Math.floor(clock / 1000) - 60);
    expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600);
    expect(first!.headers.get("accept")).toBe("application/vnd.github+json");
    expect(first!.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(first!.headers.get("user-agent")).toBe(`drop-app-${github.appId}`);
  });

  it("caches installation tokens until five minutes before they expire", async () => {
    const app = github.app();
    await app.request("/installation/repositories", { installation: 7 });
    await app.request("/installation/repositories", { installation: 7 });
    expect(github.state.tokensIssued).toBe(1);
    clock += 54 * 60 * 1000;
    await app.request("/installation/repositories", { installation: 7 });
    expect(github.state.tokensIssued).toBe(1);
    clock += 2 * 60 * 1000;
    await app.request("/installation/repositories", { installation: 7 });
    expect(github.state.tokensIssued).toBe(2);
    expect(github.calls.at(-1)!.authorization).toBe("token tok-7-2");
  });

  it("reports GitHub's status on failure", async () => {
    const failure = await github.app().request("/nowhere").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubError);
    expect((failure as GitHubError).status).toBe(404);
  });

  it("explains how to create the App when the lockfile has none", () => {
    expect(() => createGitHubApp({ appId: undefined, privateKey: github.privateKeyPem })).toThrow(NO_APP);
  });

  it("reads every page of a list", async () => {
    const o = owner();
    const repositories = Array.from({ length: 150 }, (_, i) => o.repo(`app-${i}`));
    github.state.repositories.set(o.installationId, repositories);
    const listed = await github.app().list("/installation/repositories", { installation: o.installationId, key: "repositories" });
    expect(listed).toHaveLength(150);
    expect(github.callsTo("GET", /^\/installation\/repositories$/).map((call) => call.search)).toEqual(["?per_page=100&page=1", "?per_page=100&page=2"]);
  });
});

describe("resyncInstallations", () => {
  it("records listed Owners' installations as GitHub reports them", async () => {
    const all = owner();
    const selected = owner();
    const suspended = owner();
    const foreign = owner();
    const github = await createFakeGitHub();
    const kept = selected.repo("trailhead");
    const keptOnSuspended = suspended.repo("old");
    github.state.installations = [all.installation("all"), selected.installation("selected"), suspended.installation("selected", "2026-10-01T00:00:00Z"), foreign.installation("all")];
    github.state.repositories.set(selected.installationId, [kept]);
    const owners = { [all.login]: all.accountId, [selected.login]: selected.accountId, [suspended.login]: suspended.accountId };

    // D1 is stale: the selection switched from all to selected, and the suspended one had a repository.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO installations (id, account_id, account_login, repository_selection, created_at, updated_at) VALUES (?, ?, ?, 'all', 0, 0)").bind(selected.installationId, selected.accountId, selected.login),
      env.DB.prepare("INSERT INTO installations (id, account_id, account_login, repository_selection, created_at, updated_at) VALUES (?, ?, ?, 'selected', 0, 0)").bind(suspended.installationId, suspended.accountId, suspended.login),
      env.DB.prepare("INSERT INTO installation_repositories (installation_id, repository_id, full_name) VALUES (?, ?, ?)").bind(suspended.installationId, keptOnSuspended.id, keptOnSuspended.full_name),
    ]);

    await resyncInstallations(env.DB, github.app(), owners, NOW);

    expect(await installationRow(all.installationId)).toMatchObject({ repository_selection: "all", suspended_at: null });
    expect(await installationRow(selected.installationId)).toMatchObject({ repository_selection: "selected" });
    expect(await repositoryIds(selected.installationId)).toEqual([kept.id]);
    expect((await installationRow(suspended.installationId))?.suspended_at).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect(await repositoryIds(suspended.installationId)).toEqual([keptOnSuspended.id]);
    expect(await installationRow(foreign.installationId)).toBeNull();
    // No token for the suspended installation or the "all" one: only the selected one lists repositories.
    expect(github.callsTo("POST", /access_tokens$/).map((call) => call.path)).toEqual([`/app/installations/${selected.installationId}/access_tokens`]);
  });

  it("removes listed Owners' installations GitHub no longer reports", async () => {
    const gone = owner();
    const repository = gone.repo("app");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO installations (id, account_id, account_login, repository_selection, created_at, updated_at) VALUES (?, ?, ?, 'selected', 0, 0)").bind(gone.installationId, gone.accountId, gone.login),
      env.DB.prepare("INSERT INTO installation_repositories (installation_id, repository_id, full_name) VALUES (?, ?, ?)").bind(gone.installationId, repository.id, repository.full_name),
    ]);
    await resyncInstallations(env.DB, (await createFakeGitHub()).app(), { [gone.login]: gone.accountId }, NOW);
    expect(await installationRow(gone.installationId)).toBeNull();
    expect(await repositoryIds(gone.installationId)).toEqual([]);
  });
});

describe("claimResync", () => {
  it("lets one caller resync per minute", async () => {
    expect(await claimResync(env.DB, NOW)).toBe(true);
    expect(await claimResync(env.DB, NOW + 30_000)).toBe(false);
    expect(await claimResync(env.DB, NOW + 60_000)).toBe(true);
  });
});

describe("uploads denied for a missed webhook", () => {
  async function setup(o: ReturnType<typeof owner>, github: FakeGitHub) {
    const allowList: AllowList = { owners: { [o.login]: o.accountId } };
    return createTestApp({ allowList, allowedRepositories: (e) => installationAllowedRepositories(e.DB, allowList), github: () => github.app() });
  }

  async function upload(t: Awaited<ReturnType<typeof setup>>, o: ReturnType<typeof owner>, repository: { id: number; full_name: string }) {
    const token = await t.issuer.sign({ repository: repository.full_name, repository_id: String(repository.id), repository_owner_id: String(o.accountId), run_id: String(nextId()) });
    const response = await t.app.request(
      "/api/v1/uploads",
      { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(uploadRequest(uniqueApplicationId())) },
      env,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("resyncs from GitHub and checks again", async () => {
    const o = owner();
    const repository = o.repo("trailhead");
    const github = await createFakeGitHub();
    github.state.installations = [o.installation("selected")];
    github.state.repositories.set(o.installationId, [repository]);
    const t = await setup(o, github);

    expect((await upload(t, o, repository)).status).toBe(201);
    expect(await repositoryIds(o.installationId)).toEqual([repository.id]);
  });

  it("resyncs at most once a minute and still explains the denial", async () => {
    const o = owner();
    const github = await createFakeGitHub();
    github.state.installations = [o.installation("selected")];
    const t = await setup(o, github);

    const first = await upload(t, o, o.repo("not-selected"));
    const second = await upload(t, o, o.repo("also-not-selected"));
    expect(first).toMatchObject({ status: 403, body: { code: "repository_not_selected" } });
    expect(second).toMatchObject({ status: 403, body: { code: "repository_not_selected" } });
    expect(github.callsTo("GET", /^\/app\/installations$/)).toHaveLength(1);

    t.advance(60_000);
    await upload(t, o, o.repo("later"));
    expect(github.callsTo("GET", /^\/app\/installations$/)).toHaveLength(2);
  });

  it("doesn't resync for an Owner the config doesn't list", async () => {
    const o = owner();
    const github = await createFakeGitHub();
    const t = await setup(o, github);
    const stranger = owner();
    expect((await upload(t, stranger, stranger.repo("app"))).body).toMatchObject({ code: "owner_not_listed" });
    expect(github.calls).toHaveLength(0);
  });
});

describe("runScheduled", () => {
  it("resyncs installations", async () => {
    const o = owner();
    const github = await createFakeGitHub();
    github.state.installations = [o.installation("all")];
    await runScheduled(
      { ...(await baseDependencies()), allowList: { owners: { [o.login]: o.accountId } }, github: () => github.app() },
      env,
    );
    expect(await installationRow(o.installationId)).toMatchObject({ repository_selection: "all" });
  });

  it("explains a missing App", async () => {
    await expect(runScheduled({ ...(await baseDependencies()), github: () => undefined }, env)).rejects.toThrow(/npm run setup/);
  });
});

/** Dependencies for runScheduled, which uses only the allow-list, GitHub and the clock. */
async function baseDependencies(): Promise<Dependencies> {
  return {
    allowList: { owners: {} },
    allowedRepositories: () => ({ check: async () => ({ allowed: true as const, allowEvents: [] }) }),
    verifyToken: async () => {
      throw new Error("unused");
    },
    presigner: () => {
      throw new Error("unused");
    },
    github: () => undefined,
    now: () => NOW,
  };
}
