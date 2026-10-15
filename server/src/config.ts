import rawConfig from "../../drop.config.json";
import rawLock from "../../drop.config.lock.json";

// Mirrors drop.config.schema.json. Both files are checked by `npm run check:config` before deploy and
// in tests, not at request time.

export type OwnerName = string;
export type RepositoryName = `${string}/${string}`;
export type ApplicationId = string;

export type AllowedEvent = "pull_request_target" | "workflow_run";

/** An exception for one repository. It never grants access by itself (ADR 0004). */
export interface RepositoryException {
  allowEvents: AllowedEvent[];
}

export interface Webhook {
  format: "slack" | "discord" | "json";
  products?: ApplicationId[];
  channels?: string[];
}

export interface Retention {
  buildDays?: number;
  pullRequestBuildDays?: number;
  closedPullRequestHours?: number;
}

export interface ProductOverrides {
  private?: true;
  displayName?: string;
  icon?: string;
  retention?: Retention;
}

export interface DropConfig {
  url: string;
  owners: OwnerName[];
  repositories?: Record<RepositoryName, RepositoryException>;
  webhooks?: Record<string, Webhook>;
  products?: Record<ApplicationId, ProductOverrides>;
}

/**
 * drop.config.lock.json: the numeric GitHub ID of each listed Owner, written by `npm run setup`.
 * Uploads and installations are matched against these, never names, because a renamed or deleted
 * account's name can be registered by someone else (ADR 0004).
 */
export interface DropLock {
  owners: Record<OwnerName, number>;
  /** The deployment's GitHub App, absent until `npm run setup` has created it. */
  app?: { id: number; slug: string };
}

export const config = rawConfig as DropConfig;
export const lock = rawLock as DropLock;

/** Hours a closed pull request's Builds are kept: the Product's override, else 24 (docs/design.md#retention). */
export function closedPullRequestHours(applicationId: ApplicationId): number {
  return config.products?.[applicationId]?.retention?.closedPullRequestHours ?? 24;
}
