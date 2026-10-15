/** Runs git with the given arguments and returns its stdout; throws when git fails or times out. */
export type GitRunner = (args: string[], timeoutMs: number) => string;

const LOCAL_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 20_000;

/**
 * The full message of `sha`, from the checkout. On pull_request runs `actions/checkout` makes a
 * shallow checkout of the merge commit, so the pull request's head commit is usually missing; it is
 * fetched on its own first (best effort). Returns undefined with no checkout or when git can't find it.
 */
export function readCommitMessage(git: GitRunner, sha: string): string | undefined {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`], LOCAL_TIMEOUT_MS);
  } catch {
    try {
      git(["fetch", "--no-tags", "--depth=1", "origin", sha], FETCH_TIMEOUT_MS);
    } catch {
      // No checkout, no network, or a commit the remote won't serve: the log below decides.
    }
  }
  try {
    return git(["log", "-1", "--format=%B", sha], LOCAL_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}
