import type { AllowedEvent, RepositoryException } from "./config";
import type { ErrorCode } from "./errors";

export interface UploadingRepository {
  repository: string;
  repositoryId: number;
  repositoryOwnerId: number;
}

export type AllowDecision =
  | {
      allowed: true;
      /** Events beyond the defaults that this repository may upload from (docs/design.md#upload-authentication). */
      allowEvents: readonly AllowedEvent[];
    }
  | { allowed: false; code: Extract<ErrorCode, "owner_not_listed" | "app_not_installed" | "repository_not_selected">; reason: string };

/** Decides whether a repository is an Allowed repository, by its numeric IDs (ADR 0004). */
export interface AllowedRepositories {
  check(repository: UploadingRepository): Promise<AllowDecision>;
}

export interface AllowList {
  /** Listed Owners' IDs by login, from drop.config.lock.json. */
  owners: Record<string, number>;
  /** The config's per-repository exceptions, by owner/name. */
  exceptions?: Record<string, RepositoryException>;
}

/**
 * Allowed repositories per ADR 0004: the token's Owner ID is a locked Owner, and that Owner's
 * installation of the deployment's GitHub App covers the repository.
 */
export function installationAllowedRepositories(db: D1Database, allowList: AllowList): AllowedRepositories {
  const ownerIds = new Set(Object.values(allowList.owners));
  return {
    async check({ repository, repositoryId, repositoryOwnerId }) {
      const owner = repository.split("/")[0]!;
      if (!ownerIds.has(repositoryOwnerId)) {
        return {
          allowed: false,
          code: "owner_not_listed",
          reason: `${owner} is not one of this deployment's Owners. To accept its uploads, add it to owners in drop.config.json, run \`npm run setup\`, and redeploy.`,
        };
      }
      const installation = await db
        .prepare(
          `SELECT i.repository_selection, i.suspended_at,
             EXISTS (SELECT 1 FROM installation_repositories r WHERE r.installation_id = i.id AND r.repository_id = ?) AS selected
           FROM installations i WHERE i.account_id = ?`,
        )
        .bind(repositoryId, repositoryOwnerId)
        .first<{ repository_selection: "all" | "selected"; suspended_at: number | null; selected: number }>();
      if (!installation) {
        return {
          allowed: false,
          code: "app_not_installed",
          reason: `This deployment's GitHub App is not installed on ${owner}. Install it from the App's page on GitHub and give it access to ${repository}.`,
        };
      }
      if (installation.suspended_at !== null) {
        return {
          allowed: false,
          code: "app_not_installed",
          reason: `This deployment's GitHub App is suspended on ${owner}. Unsuspend it in ${owner}'s settings under GitHub Apps.`,
        };
      }
      if (installation.repository_selection === "selected" && !installation.selected) {
        return {
          allowed: false,
          code: "repository_not_selected",
          reason: `${repository} is not among the repositories this deployment's GitHub App can access. Add it in ${owner}'s settings under GitHub Apps → Configure → Repository access.`,
        };
      }
      // An exception only widens which events may upload; it never grants access. It is keyed by
      // owner/name, so a renamed repository loses it until the config is updated.
      const exception = Object.entries(allowList.exceptions ?? {}).find(([name]) => name.toLowerCase() === repository.toLowerCase());
      return { allowed: true, allowEvents: exception?.[1].allowEvents ?? [] };
    },
  };
}
