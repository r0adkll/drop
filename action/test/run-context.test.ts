import { describe, expect, it } from "vitest";
import { chooseChannel, commitDetails, namedChannel, type RunContext } from "../src/run-context.ts";

const BUILT = "a".repeat(40);
const HEAD = "9f3c2a1".padEnd(40, "0");

function run(overrides: Partial<RunContext>): RunContext {
  return { eventName: "push", ref: "refs/heads/main", refName: "main", sha: BUILT, payload: { repository: { default_branch: "main" } }, ...overrides };
}

describe("namedChannel", () => {
  it("takes the input, else DROP_CHANNEL, and warns when they differ", () => {
    expect(namedChannel(undefined, undefined)).toEqual({ channel: undefined });
    expect(namedChannel(undefined, "beta")).toEqual({ channel: "beta" });
    expect(namedChannel("beta", "beta")).toEqual({ channel: "beta" });
    expect(namedChannel("nightly", "beta")).toMatchObject({ channel: "nightly", warning: expect.stringContaining("DROP_CHANNEL (beta)") });
  });
});

describe("chooseChannel", () => {
  it("sends default-branch runs to main", () => {
    expect(chooseChannel(run({}), undefined)).toEqual({ channel: "main", defaultBranch: true });
    expect(chooseChannel(run({ eventName: "workflow_dispatch" }), undefined)).toEqual({ channel: "main", defaultBranch: true });
    expect(chooseChannel(run({ eventName: "schedule", payload: {} }), undefined)).toEqual({ channel: "main", defaultBranch: true });
  });

  it("follows a default branch that isn't called main", () => {
    const trunk = run({ ref: "refs/heads/trunk", refName: "trunk", payload: { repository: { default_branch: "trunk" } } });
    expect(chooseChannel(trunk, undefined)).toEqual({ channel: "main", defaultBranch: true });
  });

  it("sends pull requests to pr/<number>", () => {
    const pr = run({ eventName: "pull_request", ref: "refs/pull/142/merge", refName: "142/merge", payload: {} });
    expect(chooseChannel(pr, undefined)).toEqual({ channel: "pr/142", defaultBranch: false });
  });

  it("needs a channel for other runs", () => {
    const feature = run({ ref: "refs/heads/feature", refName: "feature" });
    expect(() => chooseChannel(feature, undefined)).toThrow(/Set the action's channel input/);
    expect(() => chooseChannel(run({ eventName: "release", ref: "refs/tags/v1", refName: "v1" }), undefined)).toThrow(/channel input/);
  });

  it("uses a named Channel without marking it the default", () => {
    expect(chooseChannel(run({ eventName: "schedule" }), "nightly")).toEqual({ channel: "nightly", defaultBranch: false });
  });
});

describe("commitDetails", () => {
  const noGit = () => undefined;

  it("shows a pull request's head commit, title and message", () => {
    const pr = run({
      eventName: "pull_request",
      ref: "refs/pull/142/merge",
      payload: { pull_request: { number: 142, title: "  Offline map tiles  ", head: { sha: HEAD } } },
    });
    const asked: string[] = [];
    const details = commitDetails(pr, (sha) => {
      asked.push(sha);
      return "Cache map tiles\n\nDetails.\n";
    });
    expect(details).toEqual({ sha: HEAD, message: "Cache map tiles\n\nDetails.", pullRequestTitle: "Offline map tiles" });
    expect(asked).toEqual([HEAD]);
  });

  it("uses the pushed head commit's message", () => {
    const push = run({ payload: { head_commit: { id: BUILT, message: "Fix crash" } } });
    expect(commitDetails(push, () => "from git")).toEqual({ sha: BUILT, message: "Fix crash", pullRequestTitle: undefined });
  });

  it("falls back to git, then to nothing", () => {
    expect(commitDetails(run({ eventName: "schedule", payload: {} }), () => "Nightly tweaks\n").message).toBe("Nightly tweaks");
    expect(commitDetails(run({ eventName: "schedule", payload: {} }), noGit)).toEqual({ sha: BUILT, message: undefined, pullRequestTitle: undefined });
  });

  it("truncates long messages", () => {
    const long = commitDetails(run({ payload: { head_commit: { message: "x".repeat(20_000) } } }), noGit).message!;
    expect(long).toHaveLength(10_000);
    expect(long.endsWith("…")).toBe(true);
  });
});
