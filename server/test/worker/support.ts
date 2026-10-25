import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import type { AllowDecision, AllowedRepositories } from "../../src/allowed-repositories";
import { createApp, type Dependencies } from "../../src/index";
import { GITHUB_ISSUER, GITHUB_JWKS_URL, createTokenVerifier } from "../../src/oidc";
import { r2Presigner } from "../../src/presign";

export const AUDIENCE = "https://drop.example.com";
export const NOW = Date.UTC(2026, 9, 15, 14, 2);

/** Signs GitHub-shaped OIDC tokens and serves the matching key set through a fake fetch. */
export async function createIssuer(kid = "key-1") {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return {
    kid,
    publicJwk,
    sign(claims: Record<string, unknown> = {}, options: { audience?: string; issuer?: string; iat?: number; exp?: number; nbf?: number; kid?: string } = {}) {
      const iat = options.iat ?? Math.floor(NOW / 1000) - 10;
      const jwt = new SignJWT({ ...defaultClaims(), ...claims })
        .setProtectedHeader({ alg: "RS256", kid: options.kid ?? kid })
        .setIssuer(options.issuer ?? GITHUB_ISSUER)
        .setAudience(options.audience ?? AUDIENCE)
        .setIssuedAt(iat)
        .setExpirationTime(options.exp ?? iat + 300);
      if (options.nbf !== undefined) jwt.setNotBefore(options.nbf);
      return jwt.sign(privateKey);
    },
  };
}

export function defaultClaims(): Record<string, string> {
  return {
    repository: "your-org/trailhead",
    repository_id: "1001",
    repository_owner_id: "2001",
    repository_visibility: "public",
    event_name: "push",
    ref: "refs/heads/main",
    sha: "a".repeat(40),
    run_id: "11384729304",
    run_attempt: "1",
    run_number: "1876",
    workflow: "Android",
  };
}

/** A fetch that serves the given key sets in turn, one per call, and counts calls. */
export function jwksFetch(...sets: JWK[][]) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url !== GITHUB_JWKS_URL) return new Response("not found", { status: 404 });
    const keys = sets[Math.min(calls.length - 1, sets.length - 1)];
    return Response.json({ keys });
  }) as typeof fetch;
  return { fetch: fetchFn, calls };
}

export function fakeAllowList(decide: (repositoryId: number) => AllowDecision): AllowedRepositories {
  return { check: async ({ repositoryId }) => decide(repositoryId) };
}

export const allowAll = fakeAllowList(() => ({ allowed: true, allowEvents: [] }));

/** The Owner the default claims come from, as a lockfile would list it. */
export const TEST_ALLOW_LIST = { owners: { "your-org": 2001 } };

export async function createTestApp(overrides: Partial<Dependencies> = {}) {
  const issuer = await createIssuer();
  const keys = jwksFetch([issuer.publicJwk]);
  let now = NOW;
  const app = createApp({
    allowList: TEST_ALLOW_LIST,
    allowedRepositories: () => allowAll,
    verifyToken: createTokenVerifier({ audience: AUDIENCE, fetch: keys.fetch, now: () => now }),
    presigner: () => r2Presigner({ accountId: "test-account", accessKeyId: "test-key", secretAccessKey: "test-secret", bucket: "drop-builds" }),
    github: () => undefined,
    now: () => now,
    ...overrides,
  });
  return { app, issuer, advance: (ms: number) => (now += ms) };
}

let sequence = 0;
/** A unique application ID, so tests sharing the database don't collide. */
export function uniqueApplicationId(): string {
  sequence += 1;
  return `com.example.app${sequence}x${Math.floor(Math.random() * 1e9)}`;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function uploadRequest(applicationId: string, overrides: Record<string, unknown> = {}) {
  return {
    applicationId,
    versionCode: 4127,
    versionName: "2.8.0",
    label: "Trailhead",
    signerSha256: "3a".repeat(32),
    apk: { size: 4, sha256: "b".repeat(64) },
    channel: "main",
    defaultBranch: true,
    commit: { sha: "9f3c2a1".padEnd(40, "0"), message: "Cache map tiles" },
    ...overrides,
  };
}

export interface SeededBuild {
  id: string;
  applicationId: string;
  channelId: number;
}

let seededIds = 0;
/** A Build ID no other seeded Build uses. */
export function uniqueBuildId(): string {
  seededIds += 1;
  return `S${seededIds.toString(36).padStart(5, "0")}${Math.floor(Math.random() * 36 * 36).toString(36).padStart(2, "0")}`.slice(0, 8);
}

/**
 * Writes a confirmed Build straight to D1, creating its Product and Channel if needed, for tests that
 * start from Builds rather than uploads.
 */
export async function seedBuild(
  options: {
    applicationId?: string;
    repositoryId?: number;
    repository?: string;
    channel?: string;
    pullRequest?: number | null;
    isDefault?: boolean;
    runId?: number;
    uploadedAt?: number;
    label?: string | null;
    versionName?: string | null;
    versionCode?: number;
    iconKey?: string | null;
    deletedAt?: number | null;
    workflow?: string;
    runNumber?: number;
    commitSha?: string;
    commitMessage?: string | null;
    pullRequestTitle?: string | null;
    releaseNotes?: string | null;
    openInApp?: string | null;
    signer?: string;
    formFactor?: "mobile" | "wear";
  } = {},
): Promise<SeededBuild> {
  const db = env.DB;
  const applicationId = options.applicationId ?? uniqueApplicationId();
  const channel = options.channel ?? "main";
  const pullRequest = options.pullRequest ?? (/^pr\/(\d+)$/.exec(channel) ? Number(/^pr\/(\d+)$/.exec(channel)![1]) : null);
  await db.batch([
    db
      .prepare(
        `INSERT INTO products (application_id, repository_id, repository, repository_visibility, created_at)
         VALUES (?, ?, ?, 'public', 0) ON CONFLICT (application_id) DO NOTHING`,
      )
      .bind(applicationId, options.repositoryId ?? 1001, options.repository ?? "your-org/trailhead"),
    db
      .prepare(
        `INSERT INTO channels (application_id, name, is_default, pull_request, created_at) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (application_id, name) DO NOTHING`,
      )
      .bind(applicationId, channel, options.isDefault ?? channel === "main" ? 1 : 0, pullRequest),
  ]);
  const { id: channelId } = (await db.prepare("SELECT id FROM channels WHERE application_id = ? AND name = ?").bind(applicationId, channel).first<{ id: number }>())!;
  const id = uniqueBuildId();
  await db
    .prepare(
      `INSERT INTO builds (id, application_id, form_factor, channel_id, run_id, run_attempt, workflow, run_number, event_name, ref,
         commit_sha, built_sha, commit_message, pull_request_title, release_notes, open_in_app, version_code, version_name, label,
         signer_sha256, file_size, file_sha256, file_key, icon_key, uploaded_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'pull_request', 'refs/pull/1/merge', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 4, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, applicationId, options.formFactor ?? "mobile", channelId, options.runId ?? 11384729304, options.workflow ?? "Android", options.runNumber ?? 1876,
      options.commitSha ?? "9f3c2a1".padEnd(40, "0"), "a".repeat(40), options.commitMessage ?? null, options.pullRequestTitle ?? null, options.releaseNotes ?? null,
      options.openInApp?.replaceAll("{build}", id) ?? null,
      options.versionCode ?? 4127, options.versionName === undefined ? "2.8.0" : options.versionName,
      options.label === undefined ? "Trailhead" : options.label, options.signer ?? "3a".repeat(32), "b".repeat(64), `builds/${id}/1/app.apk`, options.iconKey ?? null, options.uploadedAt ?? NOW, options.deletedAt ?? null,
    )
    .run();
  return { id, applicationId, channelId };
}
