import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { ApiError } from "./errors";

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;

/** The OIDC claims Drop uses, with GitHub's numeric strings parsed (docs/implementation-notes.md). */
export interface GitHubClaims {
  repository: string;
  repositoryId: number;
  repositoryOwnerId: number;
  repositoryVisibility: "public" | "private" | "internal";
  eventName: string;
  ref: string;
  sha: string;
  runId: number;
  runAttempt: number;
  runNumber: number;
  workflow: string;
}

export type TokenVerifier = (token: string) => Promise<GitHubClaims>;

export interface TokenVerifierOptions {
  audience: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const KEYS_MAX_AGE_MS = 60 * 60 * 1000;
// An unknown kid triggers a refetch, at most this often, so tokens with made-up kids can't make
// every request fetch the key set.
const REFETCH_COOLDOWN_MS = 30 * 1000;
const CLOCK_TOLERANCE_S = 60;

/**
 * Verifies GitHub Actions OIDC tokens: RS256 against GitHub's key set, issuer, audience, `exp` and
 * `nbf`. The key set is cached for the isolate's lifetime and refetched once when a token names a
 * key it doesn't hold, which is how GitHub's key rotation shows up.
 */
export function createTokenVerifier({ audience, fetch: doFetch = fetch, now = Date.now }: TokenVerifierOptions): TokenVerifier {
  let keys: ReturnType<typeof createLocalJWKSet> | undefined;
  let fetchedAt = 0;

  async function loadKeys(): Promise<ReturnType<typeof createLocalJWKSet>> {
    const response = await doFetch(GITHUB_JWKS_URL, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`GitHub key set: HTTP ${response.status}`);
    keys = createLocalJWKSet((await response.json()) as JSONWebKeySet);
    fetchedAt = now();
    return keys;
  }

  async function verifyWith(set: ReturnType<typeof createLocalJWKSet>, token: string) {
    const { payload } = await jwtVerify(token, set, {
      issuer: GITHUB_ISSUER,
      audience,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_S,
      currentDate: new Date(now()),
      requiredClaims: ["exp"],
    });
    return payload;
  }

  return async (token) => {
    let payload: JWTPayload;
    try {
      const set = keys && now() - fetchedAt < KEYS_MAX_AGE_MS ? keys : await loadKeys();
      try {
        payload = await verifyWith(set, token);
      } catch (error) {
        if (!(error instanceof errors.JWKSNoMatchingKey) || now() - fetchedAt < REFETCH_COOLDOWN_MS) throw error;
        payload = await verifyWith(await loadKeys(), token);
      }
    } catch (error) {
      if (error instanceof errors.JOSEError) {
        throw new ApiError(401, "token_invalid", `The upload token was rejected: ${error.code}.`);
      }
      throw error;
    }
    return parseClaims(payload);
  };
}

function parseClaims(payload: JWTPayload): GitHubClaims {
  const text = (name: string): string => {
    const value = payload[name];
    if (typeof value !== "string" || value === "") {
      throw new ApiError(401, "token_invalid", `The upload token has no ${name} claim.`);
    }
    return value;
  };
  const integer = (name: string): number => {
    const value = text(name);
    if (!/^[0-9]{1,15}$/.test(value)) throw new ApiError(401, "token_invalid", `The upload token's ${name} claim is not a number.`);
    return Number(value);
  };
  const visibility = text("repository_visibility");
  if (visibility !== "public" && visibility !== "private" && visibility !== "internal") {
    throw new ApiError(401, "token_invalid", "The upload token's repository_visibility claim is unknown.");
  }
  return {
    repository: text("repository"),
    repositoryId: integer("repository_id"),
    repositoryOwnerId: integer("repository_owner_id"),
    repositoryVisibility: visibility,
    eventName: text("event_name"),
    ref: text("ref"),
    sha: text("sha"),
    runId: integer("run_id"),
    runAttempt: integer("run_attempt"),
    runNumber: integer("run_number"),
    workflow: text("workflow"),
  };
}
