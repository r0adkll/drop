/** What the Action reads about the run from the GitHub Actions environment. */
export interface RunContext {
  eventName: string;
  /** `GITHUB_REF`, such as `refs/heads/main` or `refs/pull/142/merge`. */
  ref: string;
  /** `GITHUB_REF_NAME`. */
  refName: string;
  /** `GITHUB_SHA`: what was checked out and built. On pull_request runs, the merge commit. */
  sha: string;
  /** The event payload from `GITHUB_EVENT_PATH`. */
  payload: EventPayload;
}

export interface EventPayload {
  repository?: { default_branch?: string };
  pull_request?: { number?: number; title?: string; head?: { sha?: string } };
  head_commit?: { id?: string; message?: string } | null;
}

export interface ChannelChoice {
  channel: string;
  /** Whether `channel` is the Product's default Channel. */
  defaultBranch: boolean;
}

const DEFAULT_CHANNEL = "main";

/**
 * The Channel the workflow names, if any: the `channel` input, else the job's `DROP_CHANNEL`
 * environment variable, which the Gradle plugin also stamps from so APKs and uploads agree. A
 * `warning` is returned when both are set and differ; the input wins.
 */
export function namedChannel(input: string | undefined, env: string | undefined): { channel?: string; warning?: string } {
  if (input && env && input !== env) {
    return { channel: input, warning: `The channel input (${input}) differs from DROP_CHANNEL (${env}), which the Gradle plugin stamped into the APK; uploading to ${input}.` };
  }
  return { channel: input || env || undefined };
}

/**
 * The Channel per docs/design.md#channels: default-branch runs (push, workflow_dispatch, schedule)
 * go to `main`, pull requests to `pr/<number>`, and any other run must name its Channel. Only a run
 * that takes the default name marks the default Channel, so a nightly schedule that names its own
 * Channel doesn't move it.
 */
export function chooseChannel(run: RunContext, input: string | undefined): ChannelChoice {
  if (input) return { channel: input, defaultBranch: false };
  if (run.eventName === "pull_request") {
    const pr = /^refs\/pull\/(\d+)\/merge$/.exec(run.ref);
    if (pr) return { channel: `pr/${pr[1]}`, defaultBranch: false };
  }
  if (isDefaultBranchRun(run)) return { channel: DEFAULT_CHANNEL, defaultBranch: true };
  throw new Error(
    `A ${run.eventName} run on ${run.ref} has no default Channel. Set the action's channel input, or run it on the default branch or a pull request.`,
  );
}

function isDefaultBranchRun(run: RunContext): boolean {
  if (!run.ref.startsWith("refs/heads/")) return false;
  // Scheduled workflows always run on the default branch, and their payload doesn't name it.
  if (run.eventName === "schedule") return true;
  if (run.eventName !== "push" && run.eventName !== "workflow_dispatch") return false;
  return run.payload.repository?.default_branch === run.refName;
}

export interface CommitDetails {
  /** The commit to show: the pull request's head commit, otherwise what was built. */
  sha: string;
  message?: string;
  pullRequestTitle?: string;
}

/**
 * Commit details for the Build page. The payload provides them where it can; otherwise the commit
 * message comes from the checkout, and is left out when there is none.
 */
export function commitDetails(run: RunContext, gitMessage: (sha: string) => string | undefined): CommitDetails {
  const pr = run.eventName === "pull_request" ? run.payload.pull_request : undefined;
  const sha = pr?.head?.sha ?? run.payload.head_commit?.id ?? run.sha;
  const message = (run.eventName === "push" ? run.payload.head_commit?.message : undefined) ?? gitMessage(sha);
  return {
    sha,
    message: truncate(message?.trim(), 10_000),
    pullRequestTitle: truncate(pr?.title?.trim(), 1000),
  };
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
