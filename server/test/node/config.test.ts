import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { githubOwnerLookup, lockErrors, resolveLock } from "../../scripts/lock.ts";
import { configErrors } from "../../scripts/validate-config.ts";

const readRoot = (name: string) => JSON.parse(readFileSync(new URL(`../../../${name}`, import.meta.url), "utf8"));
const placeholder = readRoot("drop.config.json");
const placeholderLock = readRoot("drop.config.lock.json");

describe("drop.config.schema.json", () => {
  it("accepts the placeholder config", () => {
    expect(configErrors(placeholder)).toEqual([]);
  });

  it("accepts every documented option", () => {
    expect(
      configErrors({
        url: "https://drop.example.com",
        owners: ["your-org", "you"],
        repositories: { "you/other-app": { allowEvents: ["pull_request_target"] } },
        webhooks: {
          "team-slack": { format: "slack", channels: ["main", "pr/*"] },
          ci: { format: "json", products: ["com.example.app"] },
        },
        products: {
          "com.example.app": {
            private: true,
            displayName: "Example",
            icon: "https://drop.example.com/icon.png",
            retention: { buildDays: 60 },
          },
        },
      }),
    ).toEqual([]);
  });

  it("accepts an empty owners list, which accepts no uploads", () => {
    expect(configErrors({ url: "https://drop.example.com", owners: [] })).toEqual([]);
  });

  it.each([
    ["an empty config", {}],
    ["a missing owners list", { url: "https://drop.example.com" }],
    ["the old repositories list", { url: "https://drop.example.com", owners: [], repositories: ["your-org"] }],
    ["a non-https url", { url: "http://drop.example.com", owners: [] }],
    ["a url with a path", { url: "https://drop.example.com/drop", owners: [] }],
    ["a repository as an Owner", { url: "https://drop.example.com", owners: ["you/app"] }],
    ["a malformed exception name", { url: "https://drop.example.com", owners: [], repositories: { "a/b/c": { allowEvents: ["workflow_run"] } } }],
    ["an exception without events", { url: "https://drop.example.com", owners: [], repositories: { "you/app": {} } }],
    ["an unknown event allowance", { url: "https://drop.example.com", owners: [], repositories: { "you/app": { allowEvents: ["push"] } } }],
    ["forcing a Product public", { url: "https://drop.example.com", owners: [], products: { "com.example.app": { private: false } } }],
    ["an unknown webhook format", { url: "https://drop.example.com", owners: [], webhooks: { hook: { format: "teams" } } }],
    ["an unknown key", { url: "https://drop.example.com", owners: [], extra: true }],
  ])("rejects %s", (_, value) => {
    expect(configErrors(value)).not.toEqual([]);
  });
});

describe("drop.config.lock.json", () => {
  it("matches the placeholder config", () => {
    expect(lockErrors(placeholder, placeholderLock)).toEqual([]);
  });

  it("must lock every Owner and nothing else", () => {
    const config = { owners: ["your-org", "you"] };
    expect(lockErrors(config, undefined)).toEqual([expect.stringContaining("missing")]);
    expect(lockErrors(config, { owners: { "your-org": 1 } })).toEqual([expect.stringContaining('Owner "you" has no ID')]);
    expect(lockErrors(config, { owners: { "your-org": 1, you: 2, gone: 3 } })).toEqual([expect.stringContaining('lists "gone"')]);
  });

  it("flags exceptions for repositories outside the Owners", () => {
    const config = { owners: ["your-org"], repositories: { "Your-Org/app": {}, "someone/else": {} } };
    expect(lockErrors(config, { owners: { "your-org": 1 } })).toEqual([expect.stringContaining('"someone/else" has no effect')]);
  });
});

describe("resolveLock", () => {
  const lookup = async (login: string) => ({ "your-org": 11, you: 22, newcomer: 33 })[login]!;

  it("keeps locked IDs, looks up new Owners and drops removed ones", async () => {
    const { lock, resolved } = await resolveLock(["your-org", "newcomer"], { owners: { "your-org": 1, gone: 9 } }, lookup);
    expect(lock).toEqual({ owners: { "your-org": 1, newcomer: 33 } });
    expect(resolved).toEqual(["newcomer"]);
  });

  it("looks every Owner up again on refresh", async () => {
    const { lock } = await resolveLock(["your-org"], { owners: { "your-org": 1 } }, lookup, true);
    expect(lock).toEqual({ owners: { "your-org": 11 } });
  });
});

describe("githubOwnerLookup", () => {
  it("reads the account ID, authenticating when it has a token", async () => {
    const seen: Request[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Request(input, init));
      return new URL(String(input)).pathname === "/users/your-org" ? Response.json({ id: 11, login: "your-org" }) : new Response("{}", { status: 404 });
    }) as typeof fetch;

    expect(await githubOwnerLookup("ghp_test", fetchFn)("your-org")).toBe(11);
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer ghp_test");
    await expect(githubOwnerLookup(undefined, fetchFn)("nobody")).rejects.toThrow('no user or organization "nobody"');
    expect(seen[1]!.headers.get("authorization")).toBeNull();
  });
});
