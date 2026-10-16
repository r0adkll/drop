import { describe, expect, it } from "vitest";
import type { CreatedApp, ProcessResult } from "../../scripts/github-app.ts";
import type { LockFile } from "../../scripts/lock.ts";
import {
  appStage, ciStage, cloudflareAccountStage, cloudflareTokenWorks, databaseStage, finishStage, firstDeployStage, githubRepositoryOf, jsonFrom,
  ownersStage, parseWhoami, r2CredentialsWork, runSetup, storageStage, type SetupContext, type Stage,
} from "../../scripts/setup-stages.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ok = (stdout = ""): ProcessResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string): ProcessResult => ({ status: 1, stdout: "", stderr });

type Responder = (args: string[], input?: string) => ProcessResult | undefined;

/** A setup run against scripted commands, prompts and HTTP, recording what it did. */
function harness(options: {
  lock?: LockFile;
  devVars?: Record<string, string>;
  commands?: Record<string, Responder | ProcessResult>;
  answers?: string[];
  secrets?: string[];
  choices?: number[];
  confirms?: boolean[];
  fetch?: (url: string, init?: RequestInit) => Response;
  githubToken?: string;
  owners?: string[];
  skipApp?: boolean;
  workerName?: string;
}) {
  let lock = options.lock;
  const devVars = { ...options.devVars };
  const calls: { command: string; args: string[]; input?: string; env?: Record<string, string> }[] = [];
  const attached: { command: string; args: string[]; env?: Record<string, string> }[] = [];
  const logs: string[] = [];
  const opened: string[] = [];
  const answers = [...(options.answers ?? [])];
  const secrets = [...(options.secrets ?? [])];
  const choices = [...(options.choices ?? [])];
  const confirms = [...(options.confirms ?? [])];

  const ctx: SetupContext = {
    io: {
      run: (command, args, input, env) => {
        calls.push({ command, args, input, env });
        const key = [command === "npx" ? "wrangler" : command, ...args.filter((arg) => arg !== "--no-install" && arg !== "wrangler")].join(" ");
        for (const [prefix, response] of Object.entries(options.commands ?? {})) {
          if (!key.startsWith(prefix)) continue;
          const result = typeof response === "function" ? response(args, input) : response;
          if (result) return result;
        }
        throw new Error(`Unexpected command: ${key}`);
      },
      runAttached: (command, args, env) => {
        attached.push({ command, args, env });
        return 0;
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        if (!options.fetch) throw new Error(`Unexpected fetch: ${url}`);
        return options.fetch(url, input instanceof Request ? { method: input.method, headers: input.headers } : init);
      }) as typeof fetch,
      prompts: {
        ask: async () => answers.shift() ?? "",
        askSecret: async () => secrets.shift() ?? "",
        choose: async () => choices.shift() ?? 0,
        confirm: async () => confirms.shift() ?? false,
        pause: async () => {},
      },
      openBrowser: (url) => opened.push(url),
      log: (line) => logs.push(line),
      githubToken: () => options.githubToken,
      runManifestFlow: async () => "manifest-code",
    },
    files: {
      deploymentDir: "/deployment",
      devVarsPath: "/deployment/.dev.vars",
      config: { url: "https://drop.example.com", owners: options.owners ?? ["your-org"] },
      readLock: () => lock,
      writeLock: (next) => {
        lock = next;
      },
      readDevVars: () => ({ ...devVars }),
      writeDevVars: (values) => Object.assign(devVars, values),
    },
    options: { skipApp: options.skipApp, workerName: options.workerName },
    secretsChanged: false,
    deferred: [],
  };
  return { ctx, calls, attached, logs, opened, devVars, lock: () => lock };
}

const whoami = (accounts: { id: string; name: string }[]) => ok(JSON.stringify({ loggedIn: true, email: "you@example.com", accounts }));
const cloudflareLock = { accountId: ACCOUNT, workerName: "drop", d1DatabaseId: "db-1", r2Bucket: "drop-builds" };

describe("parsing tool output", () => {
  it("finds JSON after a banner", () => {
    expect(jsonFrom("⛅️ wrangler 4\n[{\"uuid\":\"x\"}]")).toEqual([{ uuid: "x" }]);
  });

  it("reads whoami, or nothing when signed out", () => {
    expect(parseWhoami(whoami([{ id: ACCOUNT, name: "Team" }]))).toEqual({ email: "you@example.com", accounts: [{ id: ACCOUNT, name: "Team" }] });
    expect(parseWhoami(fail("not authenticated"))).toBeUndefined();
    expect(parseWhoami(ok('{"loggedIn":false}'))).toBeUndefined();
  });

  it("reads owner/name from git remotes", () => {
    expect(githubRepositoryOf("git@github.com:you/drop-deployment.git\n")).toBe("you/drop-deployment");
    expect(githubRepositoryOf("https://github.com/you/drop-deployment")).toBe("you/drop-deployment");
    expect(githubRepositoryOf("https://gitlab.com/you/drop-deployment.git")).toBeUndefined();
  });
});

describe("Cloudflare account stage", () => {
  it("signs in when needed and records the only account", async () => {
    let signedIn = false;
    const run = harness({ commands: { "wrangler whoami": () => (signedIn ? whoami([{ id: ACCOUNT, name: "Team" }]) : fail("not authenticated")) } });
    run.ctx.io.runAttached = (command, args) => {
      signedIn = args.includes("login");
      return 0;
    };
    expect(await cloudflareAccountStage.run(run.ctx)).toMatchObject({ status: "done" });
    expect(run.lock()?.cloudflare).toEqual({ accountId: ACCOUNT, workerName: "drop" });
  });

  it("asks which account when there are several", async () => {
    const run = harness({ commands: { "wrangler whoami": whoami([{ id: "a".repeat(32), name: "Personal" }, { id: ACCOUNT, name: "Team" }]) }, choices: [1], workerName: "drop-team" });
    await cloudflareAccountStage.run(run.ctx);
    expect(run.lock()?.cloudflare).toEqual({ accountId: ACCOUNT, workerName: "drop-team" });
  });

  it("is already done when the locked account is reachable", async () => {
    const run = harness({ lock: { owners: {}, cloudflare: { accountId: ACCOUNT, workerName: "drop" } }, commands: { "wrangler whoami": whoami([{ id: ACCOUNT, name: "Team" }]) } });
    expect(await cloudflareAccountStage.run(run.ctx)).toMatchObject({ status: "unchanged" });
  });

  it("refuses a login that can't reach the locked account, or a new Worker name", async () => {
    const other = harness({ lock: { owners: {}, cloudflare: { accountId: ACCOUNT } }, commands: { "wrangler whoami": whoami([{ id: "b".repeat(32), name: "Other" }]) } });
    await expect(cloudflareAccountStage.run(other.ctx)).rejects.toThrow(/can't reach/);
    const renamed = harness({ lock: { owners: {}, cloudflare: { accountId: ACCOUNT, workerName: "drop" } }, commands: { "wrangler whoami": whoami([{ id: ACCOUNT, name: "Team" }]) }, workerName: "else" });
    await expect(cloudflareAccountStage.run(renamed.ctx)).rejects.toThrow(/already "drop"/);
  });
});

describe("D1 stage", () => {
  const lock = { owners: {}, cloudflare: { accountId: ACCOUNT, workerName: "drop" } };

  it("creates the database and records its ID, on the deployment's account", async () => {
    let created = false;
    const run = harness({
      lock,
      commands: {
        "wrangler d1 list": () => ok(JSON.stringify(created ? [{ uuid: "db-1", name: "drop" }] : [])),
        "wrangler d1 create drop": () => {
          created = true;
          return ok("Created");
        },
      },
    });
    expect(await databaseStage.run(run.ctx)).toMatchObject({ status: "done", summary: expect.stringContaining("Created") });
    expect(run.lock()?.cloudflare?.d1DatabaseId).toBe("db-1");
    expect(run.calls.every((call) => call.env?.CLOUDFLARE_ACCOUNT_ID === ACCOUNT)).toBe(true);
  });

  it("adopts an existing database of the Worker's name, and skips a locked one", async () => {
    const existing = harness({ lock, commands: { "wrangler d1 list": ok(JSON.stringify([{ uuid: "db-9", name: "drop" }])) } });
    expect(await databaseStage.run(existing.ctx)).toMatchObject({ status: "done", summary: expect.stringContaining("existing") });
    expect(existing.lock()?.cloudflare?.d1DatabaseId).toBe("db-9");

    const locked = harness({ lock: { owners: {}, cloudflare: { ...lock.cloudflare, d1DatabaseId: "db-9" } }, commands: { "wrangler d1 list": ok(JSON.stringify([{ uuid: "db-9", name: "drop" }])) } });
    expect(await databaseStage.run(locked.ctx)).toMatchObject({ status: "unchanged" });
  });
});

describe("R2 stage", () => {
  const lock = { owners: {}, cloudflare: { accountId: ACCOUNT, workerName: "drop" } };
  const r2 = (accepted: string) => (url: string, init?: RequestInit) => {
    expect(url).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com/drop-builds?list-type=2&max-keys=1`);
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(null, { status: authorization.includes(`Credential=${accepted}/`) ? 200 : 403 });
  };

  it("creates the bucket, then asks for a token until one works", async () => {
    const run = harness({
      lock,
      commands: { "wrangler r2 bucket info": fail("not found"), "wrangler r2 bucket create drop-builds": ok() },
      answers: ["wrong-key", "good-key"],
      secrets: ["secret-1", "secret-2"],
      fetch: r2("good-key"),
    });
    expect(await storageStage.run(run.ctx)).toMatchObject({ status: "done" });
    expect(run.lock()?.cloudflare?.r2Bucket).toBe("drop-builds");
    expect(run.devVars).toEqual({ R2_ACCOUNT_ID: ACCOUNT, R2_ACCESS_KEY_ID: "good-key", R2_SECRET_ACCESS_KEY: "secret-2" });
    expect(run.ctx.secretsChanged).toBe(true);
    expect(run.opened).toEqual([`https://dash.cloudflare.com/${ACCOUNT}/r2/api-tokens`]);
    expect(run.logs.join("\n")).not.toContain("secret-2");
  });

  it("sends the operator to enable R2 when the account hasn't", async () => {
    let enabled = false;
    const run = harness({
      lock,
      commands: {
        "wrangler r2 bucket info": fail("not found"),
        "wrangler r2 bucket create": () => (enabled ? ok() : ((enabled = true), fail("Please enable R2 through the Cloudflare Dashboard. [code: 10042]"))),
      },
      answers: ["good-key"],
      secrets: ["secret"],
      fetch: r2("good-key"),
    });
    await storageStage.run(run.ctx);
    expect(run.opened[0]).toBe(`https://dash.cloudflare.com/${ACCOUNT}/r2/overview`);
  });

  it("is already done when the bucket exists and .dev.vars has working credentials", async () => {
    const run = harness({
      lock,
      devVars: { R2_ACCOUNT_ID: ACCOUNT, R2_ACCESS_KEY_ID: "good-key", R2_SECRET_ACCESS_KEY: "secret" },
      commands: { "wrangler r2 bucket info drop-builds": ok("{}") },
      fetch: r2("good-key"),
    });
    expect(await storageStage.run(run.ctx)).toMatchObject({ status: "unchanged" });
    expect(run.ctx.secretsChanged).toBe(false);
  });

  it("checks credentials with a signed bucket listing", async () => {
    expect(await r2CredentialsWork((async () => new Response(null, { status: 403 })) as typeof fetch, { accountId: ACCOUNT, bucket: "b", accessKeyId: "k", secretAccessKey: "s" })).toBe(false);
  });
});

describe("Owners stage", () => {
  it("locks new Owners and reports nothing to do on a second run", async () => {
    const run = harness({ owners: ["your-org"], fetch: () => Response.json({ id: 11 }) });
    expect(await ownersStage.run(run.ctx)).toMatchObject({ status: "done", summary: "Locked your-org as 11." });
    expect(await ownersStage.run(run.ctx)).toMatchObject({ status: "unchanged" });
  });
});

describe("GitHub App stage", () => {
  const app: CreatedApp = {
    id: 4242, slug: "drop-example", name: "Drop drop.example.com", html_url: "https://github.com/apps/drop-example",
    owner: { login: "you", id: 22 }, client_id: "Iv1.abc", client_secret: "client-secret", webhook_secret: "hook-secret",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n",
  };
  const github = (url: string) =>
    url.endsWith("/user") ? Response.json({ login: "you", id: 22 }) : url.includes("/app-manifests/manifest-code/conversions") ? Response.json(app, { status: 201 }) : new Response(null, { status: 404 });

  it("creates the App and keeps its secrets out of the lockfile", async () => {
    const run = harness({ lock: { owners: { you: 22 } }, githubToken: "gho_test", fetch: github });
    expect(await appStage.run(run.ctx)).toMatchObject({ status: "done" });
    expect(run.lock()?.app).toEqual({ id: 4242, slug: "drop-example", clientId: "Iv1.abc" });
    expect(run.devVars.GITHUB_APP_PRIVATE_KEY).toBe(app.pem);
    expect(JSON.stringify(run.lock())).not.toContain("hook-secret");
    expect(run.ctx.secretsChanged).toBe(true);
    expect(run.logs.join("\n")).toContain("private App");
    expect(run.ctx.deferred).toEqual([expect.stringMatching(/drop-app-logo\.png under Display information at https:\/\/github\.com\/settings\/apps\/drop-example$/)]);
  });

  it("is already done when the lockfile has an App, and needs a GitHub login otherwise", async () => {
    const existing = harness({ lock: { owners: {}, app: { id: 1, slug: "drop-example" } } });
    expect(await appStage.run(existing.ctx)).toMatchObject({ status: "unchanged" });
    await expect(appStage.run(harness({ lock: { owners: {} } }).ctx)).rejects.toThrow(/gh auth login/);
  });

  it("defers when skipped", async () => {
    const run = harness({ lock: { owners: {} }, skipApp: true });
    expect(await appStage.run(run.ctx)).toMatchObject({ status: "deferred" });
    expect(run.ctx.deferred).toHaveLength(1);
  });
});

describe("first deploy stage", () => {
  const lock = { owners: {}, cloudflare: cloudflareLock };
  const notDeployed = fail("This Worker does not exist on your account. [code: 10007]");

  it("deploys with .dev.vars once the operator agrees", async () => {
    const run = harness({ lock, commands: { "wrangler secret list --name drop": notDeployed }, confirms: [true] });
    expect(await firstDeployStage.run(run.ctx)).toMatchObject({ status: "done" });
    expect(run.attached).toEqual([{ command: "node", args: ["scripts/deployment.ts", "deploy", "--secrets"], env: { DROP_DEPLOYMENT_DIR: "/deployment" } }]);
    expect(run.logs.join("\n")).toContain("Custom Domain");
  });

  it("leaves the deploy for later when the operator declines", async () => {
    const run = harness({ lock, commands: { "wrangler secret list": notDeployed }, confirms: [false] });
    expect(await firstDeployStage.run(run.ctx)).toMatchObject({ status: "deferred" });
    expect(run.ctx.deferred[0]).toContain("./drop deploy --secrets");
    expect(run.attached).toEqual([]);
  });

  it("pushes only new secrets to a Worker that is already deployed", async () => {
    const unchanged = harness({ lock, commands: { "wrangler secret list": ok("[]") } });
    expect(await firstDeployStage.run(unchanged.ctx)).toMatchObject({ status: "unchanged" });

    const changed = harness({ lock, devVars: { R2_ACCESS_KEY_ID: "key", UNRELATED: "x" }, commands: { "wrangler secret list": ok("[]"), "wrangler secret bulk --name drop": ok() } });
    changed.ctx.secretsChanged = true;
    expect(await firstDeployStage.run(changed.ctx)).toMatchObject({ status: "done" });
    expect(JSON.parse(changed.calls.at(-1)!.input!)).toEqual({ R2_ACCESS_KEY_ID: "key" });
  });
});

describe("CI credentials stage", () => {
  const lock = { owners: {}, cloudflare: cloudflareLock };
  const remote = ok("git@github.com:you/drop-deployment.git\n");
  const cloudflareApi = (active: string) => (url: string, init?: RequestInit) => {
    const token = new Headers(init?.headers).get("authorization");
    return url.startsWith("https://api.cloudflare.com/client/v4/") && token === `Bearer ${active}`
      ? Response.json({ success: true, result: { status: "active" } })
      : Response.json({ success: false }, { status: 401 });
  };

  it("stores a verified token and the account ID in the repository's Actions settings", async () => {
    const run = harness({
      lock,
      commands: {
        "git -C /deployment remote get-url origin": remote,
        "gh auth status": ok(),
        "gh secret list": ok("[]"),
        "gh variable list": ok("[]"),
        "gh variable set CLOUDFLARE_ACCOUNT_ID": ok(),
        "gh secret set CLOUDFLARE_API_TOKEN": ok(),
      },
      secrets: ["bad-token", "cf-token"],
      fetch: cloudflareApi("cf-token"),
    });
    expect(await ciStage.run(run.ctx)).toMatchObject({ status: "done" });
    const variable = run.calls.find((call) => call.args.includes("variable") && call.args.includes("set"))!;
    expect(variable.args).toEqual(["variable", "set", "CLOUDFLARE_ACCOUNT_ID", "--body", ACCOUNT, "--repo", "you/drop-deployment"]);
    const secret = run.calls.find((call) => call.args.includes("secret") && call.args.includes("set"))!;
    expect(secret.args).toEqual(["secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", "you/drop-deployment"]);
    expect(secret.input).toBe("cf-token");
    expect(run.calls.some((call) => call.args.includes("cf-token"))).toBe(false);
  });

  it("is already done when both are set", async () => {
    const run = harness({
      lock,
      commands: {
        "git -C /deployment remote get-url origin": remote,
        "gh auth status": ok(),
        "gh secret list": ok(JSON.stringify([{ name: "CLOUDFLARE_API_TOKEN" }])),
        "gh variable list": ok(JSON.stringify([{ name: "CLOUDFLARE_ACCOUNT_ID", value: ACCOUNT }])),
      },
    });
    expect(await ciStage.run(run.ctx)).toMatchObject({ status: "unchanged" });
  });

  it("leaves the credentials to the operator without a GitHub remote", async () => {
    const run = harness({ lock, commands: { "git -C /deployment remote get-url origin": fail("No such remote") } });
    expect(await ciStage.run(run.ctx)).toMatchObject({ status: "deferred" });
    expect(run.logs.join("\n")).toContain(`gh variable set CLOUDFLARE_ACCOUNT_ID --body ${ACCOUNT}`);
  });

  it("verifies user and account tokens", async () => {
    const fetchFn = (async (url: string, init?: RequestInit) => cloudflareApi("t")(url, init)) as typeof fetch;
    expect(await cloudflareTokenWorks(fetchFn, "t", ACCOUNT)).toBe(true);
    expect(await cloudflareTokenWorks(fetchFn, "nope", ACCOUNT)).toBe(false);
  });
});

describe("running setup", () => {
  it("announces each stage with its position and ends with what is left", async () => {
    const run = harness({ lock: { owners: { you: 1 }, app: { id: 1, slug: "drop-example" } } });
    run.ctx.deferred.push("Deploy the Worker the first time: `./drop deploy --secrets`.");
    const stages: Stage[] = [{ title: "Example", run: async () => ({ status: "unchanged", summary: "Nothing to do." }) }, finishStage];
    const results = await runSetup(run.ctx, stages);
    expect(results.map((result) => result.status)).toEqual(["unchanged", "deferred"]);
    const log = run.logs.join("\n");
    expect(log).toContain("▸ Stage 1/2 · Example");
    expect(log).toContain("https://github.com/apps/drop-example/installations/new");
    expect(log).toContain("Still to do: Deploy the Worker");
  });

  it("names the stage that failed", async () => {
    const run = harness({});
    await expect(runSetup(run.ctx, [{ title: "Broken", run: async () => Promise.reject(new Error("boom")) }])).rejects.toThrow("Broken: boom");
  });
});
