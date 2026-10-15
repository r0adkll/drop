import { config, closedPullRequestHours, type ApplicationId } from "./config";

// The retention rules of docs/design.md#retention, as pure functions shared by the Build page and,
// later, the Cron Trigger that applies them.

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Days a Build that isn't its Channel's newest is kept after upload: the override, else 30. */
export function buildDays(applicationId: ApplicationId): number {
  return config.products?.[applicationId]?.retention?.buildDays ?? 30;
}

/** Days a Pull request channel's older Builds are kept after upload: the override, else 7. */
export function pullRequestBuildDays(applicationId: ApplicationId): number {
  return config.products?.[applicationId]?.retention?.pullRequestBuildDays ?? 7;
}

export interface RetainedBuild {
  applicationId: ApplicationId;
  uploadedAt: number;
  /** Whether the Build is on a Pull request channel. */
  pullRequest: boolean;
  /** When its Pull request channel ended, if it has. */
  channelEndedAt: number | null;
  /** Whether it is the newest Build of its Channel. */
  newest: boolean;
}

export type Kept =
  /** Kept for as long as it stays the newest Build of its open Channel. */
  | { kind: "while_newest" }
  /** Deleted at `at`; `reason` says which rule decides it. */
  | { kind: "until"; at: number; reason: "age" | "channel_ended" };

/** When a Build will be deleted, by the rules in docs/design.md#retention. */
export function keptUntil(build: RetainedBuild): Kept {
  const byAge = build.uploadedAt + (build.pullRequest ? pullRequestBuildDays(build.applicationId) : buildDays(build.applicationId)) * DAY;
  if (build.channelEndedAt !== null) {
    const byEnd = build.channelEndedAt + closedPullRequestHours(build.applicationId) * HOUR;
    // The newest Build is kept only while its Channel is open.
    if (build.newest || byEnd <= byAge) return { kind: "until", at: byEnd, reason: "channel_ended" };
    return { kind: "until", at: byAge, reason: "age" };
  }
  if (build.newest) return { kind: "while_newest" };
  return { kind: "until", at: byAge, reason: "age" };
}
