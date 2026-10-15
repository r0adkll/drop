import rawConfig from "../../drop.config.json";

// Mirrors drop.config.schema.json. The file is checked against the schema by `npm run check:config`
// before deploy and in tests, not at request time.

export type OwnerName = string;
export type RepositoryName = `${string}/${string}`;
export type ApplicationId = string;

export type AllowedEvent = "pull_request_target" | "workflow_run";

export interface RepositoryEntry {
  repository: RepositoryName;
  allowEvents?: AllowedEvent[];
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
  repositories: (OwnerName | RepositoryName | RepositoryEntry)[];
  webhooks?: Record<string, Webhook>;
  products?: Record<ApplicationId, ProductOverrides>;
}

/**
 * The numeric GitHub IDs behind the `repositories` entries. Uploads are matched against these, never
 * names, because a deleted account's name can be registered again (ADR 0004). Resolving them is
 * setup's job and not built yet.
 */
export interface ResolvedRepositories {
  ownerIds: Record<OwnerName, number>;
  repositoryIds: Record<RepositoryName, { id: number; allowEvents: AllowedEvent[] }>;
}

export const config = rawConfig as DropConfig;
