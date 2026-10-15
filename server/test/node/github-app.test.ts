import { describe, expect, it } from "vitest";
import {
  APP_NAME_LIMIT, appIsPublic, appManifest, appSecrets, convertManifestCode, defaultAppName, manifestFormPage, pushSecrets,
  readCallback, readDevVars, runManifestFlow, setupAccount, upsertDevVars, type CreatedApp, type ProcessRunner,
} from "../../scripts/github-app.ts";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----\n";
const created: CreatedApp = {
  id: 4242, slug: "drop-example", name: "Drop drop.example.com", html_url: "https://github.com/apps/drop-example",
  owner: { login: "you", id: 1000002 }, client_id: "Iv23li", client_secret: "client-secret", webhook_secret: "hook-secret", pem: PEM,
};

describe("the App manifest", () => {
  it("asks for exactly the permissions and events ADR 0010 grants", () => {
    const manifest = appManifest({ deploymentUrl: "https://drop.example.com/", redirectUrl: "http://127.0.0.1:5000/callback", isPublic: true });
    expect(manifest).toEqual({
      name: "Drop drop.example.com",
      url: "https://drop.example.com",
      hook_attributes: { url: "https://drop.example.com/api/v1/github/webhook", active: true },
      redirect_url: "http://127.0.0.1:5000/callback",
      public: true,
      default_permissions: { metadata: "read", pull_requests: "write" },
      default_events: ["pull_request"],
    });
  });

  it("keeps names within GitHub's limit", () => {
    expect(defaultAppName("https://builds.a-very-long-subdomain.example.com").length).toBeLessThanOrEqual(APP_NAME_LIMIT);
    const named = appManifest({ deploymentUrl: "https://drop.example.com", redirectUrl: "x", isPublic: false, name: "x".repeat(50) });
    expect(named.name).toHaveLength(APP_NAME_LIMIT);
  });

  it("is private only when the setup account is the sole Owner", () => {
    expect(appIsPublic([1000002], 1000002)).toBe(false);
    expect(appIsPublic([1000001, 1000002], 1000002)).toBe(true);
    expect(appIsPublic([1000001], 1000002)).toBe(true);
    expect(appIsPublic([], 1000002)).toBe(true);
  });

  it("is posted to GitHub's personal create-App form with the state, escaped", () => {
    const manifest = appManifest({ deploymentUrl: "https://drop.example.com", redirectUrl: "x", isPublic: false, name: 'Drop "<test>"' });
    const page = manifestFormPage(manifest, "st&te");
    expect(page).toContain('action="https://github.com/settings/apps/new?state=st%26te"');
    expect(page).toContain("&quot;Drop \\&quot;&lt;test&gt;\\&quot;&quot;");
    expect(page).not.toContain("<test>");
  });
});

describe("GitHub's redirect", () => {
  it("must carry this run's state and a code", () => {
    const url = (query: string) => new URL(`http://127.0.0.1:5000/callback?${query}`);
    expect(readCallback(url("code=abc&state=s1"), "s1")).toEqual({ ok: true, code: "abc" });
    expect(readCallback(url("code=abc&state=other"), "s1")).toMatchObject({ ok: false });
    expect(readCallback(url("code=abc"), "s1")).toMatchObject({ ok: false });
    expect(readCallback(url("state=s1"), "s1")).toMatchObject({ ok: false });
  });

  it("resolves the flow with the code once the local callback is hit", async () => {
    let page = "";
    const code = await runManifestFlow({
      buildManifest: (redirectUrl) => appManifest({ deploymentUrl: "https://drop.example.com", redirectUrl, isPublic: false }),
      log: () => {},
      openBrowser: (url) => {
        void (async () => {
          page = await (await fetch(url)).text();
          const state = /state=([^"&]+)/.exec(page)![1]!;
          expect((await fetch(`${new URL(url).origin}/callback?code=abc&state=wrong`)).status).toBe(400);
          await fetch(`${new URL(url).origin}/callback?code=the-code&state=${state}`);
        })();
      },
    });
    expect(code).toBe("the-code");
    expect(page).toContain("/callback");
  });

  it("times out", async () => {
    await expect(
      runManifestFlow({ buildManifest: (redirectUrl) => appManifest({ deploymentUrl: "https://drop.example.com", redirectUrl, isPublic: false }), log: () => {}, openBrowser: () => {}, timeoutMs: 20 }),
    ).rejects.toThrow(/Timed out/);
  });
});

describe("GitHub API calls", () => {
  it("converts a manifest code without authentication", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      request = { url, init };
      return Response.json(created, { status: 201 });
    }) as typeof fetch;
    await expect(convertManifestCode("c0de", fetchFn)).resolves.toEqual(created);
    expect(request!.url).toBe("https://api.github.com/app-manifests/c0de/conversions");
    expect(request!.init!.method).toBe("POST");
    expect((request!.init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("fails on an expired code or an incomplete answer", async () => {
    await expect(convertManifestCode("c", (async () => new Response("Not Found", { status: 404 })) as typeof fetch)).rejects.toThrow(/404/);
    await expect(convertManifestCode("c", (async () => Response.json({ ...created, pem: "" }, { status: 201 })) as typeof fetch)).rejects.toThrow(/missing/);
  });

  it("identifies the setup account", async () => {
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer t0ken");
      return Response.json({ login: "you", id: 1000002 });
    }) as typeof fetch;
    await expect(setupAccount("t0ken", fetchFn)).resolves.toEqual({ login: "you", id: 1000002 });
    await expect(setupAccount("bad", (async () => new Response("", { status: 401 })) as typeof fetch)).rejects.toThrow(/gh auth login/);
  });
});

describe(".dev.vars", () => {
  it("upserts secrets, keeping other lines, and round-trips a PEM on one line", () => {
    const before = 'R2_ACCOUNT_ID=abc\nGITHUB_WEBHOOK_SECRET="old"\n';
    const after = upsertDevVars(before, appSecrets(created));
    expect(after.split("\n")).toEqual([
      "R2_ACCOUNT_ID=abc",
      'GITHUB_WEBHOOK_SECRET="hook-secret"',
      'GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nMIIBOgIBAAJBAK\\n-----END RSA PRIVATE KEY-----\\n"',
      'GITHUB_APP_CLIENT_SECRET="client-secret"',
      "",
    ]);
    expect(upsertDevVars(after, appSecrets(created))).toBe(after);
    expect(readDevVars(after)).toEqual({ R2_ACCOUNT_ID: "abc", ...appSecrets(created) });
  });

  it("starts a missing file", () => {
    expect(upsertDevVars("", { A: 'quote " and \\' })).toBe('A="quote \\" and \\\\"\n');
    expect(readDevVars(upsertDevVars("", { A: 'quote " and \\' }))).toEqual({ A: 'quote " and \\' });
  });
});

describe("pushing secrets to the Worker", () => {
  const recorder = (listStatus: number, listOutput = "", bulkStatus = 0) => {
    const calls: { args: string[]; input?: string }[] = [];
    const run: ProcessRunner = (_command, args, input) => {
      calls.push({ args, input });
      if (args.includes("list")) return { status: listStatus, stdout: "", stderr: listOutput };
      return { status: bulkStatus, stdout: "", stderr: "bulk failed" };
    };
    return { calls, run };
  };

  it("bulk-uploads them through stdin when the Worker exists", () => {
    const { calls, run } = recorder(0);
    expect(pushSecrets(run, appSecrets(created))).toBe("pushed");
    expect(calls.map((call) => call.args)).toEqual([
      ["--no-install", "wrangler", "secret", "list"],
      ["--no-install", "wrangler", "secret", "bulk"],
    ]);
    expect(JSON.parse(calls[1]!.input!)).toEqual(appSecrets(created));
    expect(calls[1]!.args.join(" ")).not.toContain("hook-secret");
  });

  it("leaves them for the first deploy when the Worker doesn't exist", () => {
    const { calls, run } = recorder(1, "✘ [ERROR] A request to the Cloudflare API failed. This Worker does not exist on your account. [code: 10007]");
    expect(pushSecrets(run, appSecrets(created))).toBe("not-deployed");
    expect(calls).toHaveLength(1);
  });

  it("fails clearly on other errors", () => {
    expect(() => pushSecrets(recorder(1, "Not logged in").run, appSecrets(created))).toThrow(/wrangler login/);
    expect(() => pushSecrets(recorder(0, "", 1).run, appSecrets(created))).toThrow(/bulk failed/);
  });
});
