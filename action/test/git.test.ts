import { describe, expect, it } from "vitest";
import { readCommitMessage, type GitRunner } from "../src/git.ts";

const SHA = "9f3c2a1".padEnd(40, "0");

/** A git that knows the given commits, and learns `fetchable` ones when they're fetched. */
function fakeGit({ present = [] as string[], fetchable = [] as string[], fetchFails = false } = {}) {
  const known = new Set(present);
  const calls: string[] = [];
  const git: GitRunner = (args, timeoutMs) => {
    calls.push(`${args.join(" ")} (${timeoutMs}ms)`);
    const [command] = args;
    const sha = args.at(-1)!.replace("^{commit}", "");
    if (command === "cat-file") {
      if (!known.has(sha)) throw new Error("missing");
      return "";
    }
    if (command === "fetch") {
      if (fetchFails || !fetchable.includes(sha)) throw new Error("fetch failed");
      known.add(sha);
      return "";
    }
    if (command === "log") {
      if (!known.has(sha)) throw new Error("unknown revision");
      return "Cache map tiles\n\nIn the background.\n";
    }
    throw new Error(`unexpected git ${command}`);
  };
  return { git, calls };
}

describe("readCommitMessage", () => {
  it("reads a commit the checkout already has without fetching", () => {
    const { git, calls } = fakeGit({ present: [SHA] });
    expect(readCommitMessage(git, SHA)).toBe("Cache map tiles\n\nIn the background.\n");
    expect(calls).toEqual([`cat-file -e ${SHA}^{commit} (5000ms)`, `log -1 --format=%B ${SHA} (5000ms)`]);
  });

  it("fetches a pull request's head commit missing from a shallow merge checkout", () => {
    const { git, calls } = fakeGit({ fetchable: [SHA] });
    expect(readCommitMessage(git, SHA)).toBe("Cache map tiles\n\nIn the background.\n");
    expect(calls).toEqual([
      `cat-file -e ${SHA}^{commit} (5000ms)`,
      `fetch --no-tags --depth=1 origin ${SHA} (20000ms)`,
      `log -1 --format=%B ${SHA} (5000ms)`,
    ]);
  });

  it("gives up quietly when the fetch fails or there is no checkout", () => {
    expect(readCommitMessage(fakeGit({ fetchFails: true }).git, SHA)).toBeUndefined();
    expect(readCommitMessage(fakeGit().git, SHA)).toBeUndefined();
  });
});
