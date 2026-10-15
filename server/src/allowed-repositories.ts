import type { AllowedEvent } from "./config";
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
  | { allowed: false; code: Extract<ErrorCode, "repository_not_allowed" | "allow_list_not_configured">; reason: string };

/**
 * Decides whether a repository is an Allowed repository, by its numeric IDs (ADR 0004). Where those
 * IDs come from (a setup lockfile, the GitHub App's installations) is not decided yet, so uploads
 * depend on this seam only.
 */
export interface AllowedRepositories {
  check(repository: UploadingRepository): Promise<AllowDecision>;
}

/** Until the allow-list source is built, a deployment accepts no uploads. */
export const unconfiguredAllowedRepositories: AllowedRepositories = {
  async check() {
    return {
      allowed: false,
      code: "allow_list_not_configured",
      reason: "This deployment has no allow-list set up yet, so it accepts no uploads.",
    };
  },
};
