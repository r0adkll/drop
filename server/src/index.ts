import { Hono, type Context } from "hono";
import { installationAllowedRepositories, type AllowedRepositories, type AllowList } from "./allowed-repositories";
import { config, lock } from "./config";
import { ApiError, type ErrorBody } from "./errors";
import type { components } from "./generated/openapi";
import { handleWebhook, verifyWebhookSignature, WebhookPayloadError } from "./github-webhook";
import { createGitHubApp, NO_APP, type GitHubApp } from "./github/client";
import { claimResync, resyncInstallations } from "./github/installations";
import { createTokenVerifier, type GitHubClaims, type TokenVerifier } from "./oidc";
import { r2Presigner, type Presigner } from "./presign";
import { qrSvg } from "./qr";
import { buildUrl, completeUpload, createUpload, parseCreateUpload } from "./uploads";

type Health = components["schemas"]["Health"];
type WebhookResult = components["schemas"]["WebhookResult"];

export interface Dependencies {
  /** Listed Owners and repository exceptions, from the config and its lockfile. */
  allowList: AllowList;
  allowedRepositories: (env: Env) => AllowedRepositories;
  verifyToken: TokenVerifier;
  presigner: (env: Env) => Presigner;
  /** The deployment's GitHub App, or undefined until setup has created it and its key is set. */
  github: (env: Env) => GitHubApp | undefined;
  now: () => number;
}

const BUILD_ID = /^[0-9A-Za-z]{8}$/;

export function createApp(deps: Dependencies) {
  const app = new Hono<{ Bindings: Env }>();

  async function claimsOf(c: Context<{ Bindings: Env }>): Promise<GitHubClaims> {
    const header = c.req.header("authorization");
    const token = header?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token) throw new ApiError(401, "token_missing", "Send the GitHub Actions OIDC token as a Bearer token.");
    return deps.verifyToken(token);
  }

  function waitUntil(c: Context): (promise: Promise<unknown>) => void {
    return (promise) => {
      try {
        c.executionCtx.waitUntil(promise);
      } catch {
        // No execution context (app.request in tests): let it run unawaited.
        promise.catch((error) => console.error(error));
      }
    };
  }

  app.get("/api/v1/health", (c) => c.json<Health>({ status: "ok" }));

  app.post("/api/v1/uploads", async (c) => {
    const claims = await claimsOf(c);
    const body = await c.req.json().catch(() => {
      throw new ApiError(400, "invalid_request", "The body must be JSON.");
    });
    const response = await createUpload(
      {
        env: c.env,
        claims,
        allowedRepositories: deps.allowedRepositories(c.env),
        presigner: deps.presigner(c.env),
        now: deps.now(),
        waitUntil: waitUntil(c),
        resyncInstallations: () => resyncIfDue(deps, c.env),
      },
      parseCreateUpload(body),
    );
    return c.json(response, 201);
  });

  app.post("/api/v1/uploads/:buildId/complete", async (c) => {
    const buildId = c.req.param("buildId");
    if (!BUILD_ID.test(buildId)) throw new ApiError(404, "build_not_found", `There is no Build ${buildId}.`);
    const claims = await claimsOf(c);
    return c.json(await completeUpload({ env: c.env, claims, now: deps.now(), waitUntil: waitUntil(c) }, buildId));
  });

  app.post("/api/v1/github/webhook", async (c) => {
    const body = await c.req.arrayBuffer();
    if (!(await verifyWebhookSignature(c.env.GITHUB_WEBHOOK_SECRET, body, c.req.header("x-hub-signature-256")))) {
      throw new ApiError(401, "webhook_signature_invalid", "The X-Hub-Signature-256 header doesn't match the webhook secret.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new ApiError(400, "invalid_request", "The body must be JSON.");
    }
    try {
      const result = await handleWebhook(c.env.DB, deps.allowList.owners, c.req.header("x-github-event") ?? "", payload, deps.now());
      return c.json<WebhookResult>({ result });
    } catch (error) {
      if (error instanceof WebhookPayloadError) throw new ApiError(400, "invalid_request", error.message);
      throw error;
    }
  });

  // A Build's QR code never changes: it encodes the Build page URL, which is fixed by its ID. It is
  // served for expired Builds too, so old comments keep their images.
  app.get("/b/:buildId/qr.svg", async (c) => {
    const buildId = await existingBuild(c.env, c.req.param("buildId"));
    return c.body(qrSvg(buildUrl(buildId)), 200, {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  // Icons outlive their Build's file (docs/design.md#retention). A later attempt of the run may
  // bring a new icon under the same ID, so they are cached for an hour, not forever.
  app.get("/b/:buildId/icon", async (c) => {
    const buildId = c.req.param("buildId");
    const build = BUILD_ID.test(buildId)
      ? await c.env.DB.prepare("SELECT icon_key FROM builds WHERE id = ?").bind(buildId).first<{ icon_key: string | null }>()
      : null;
    const icon = build?.icon_key ? await c.env.BUILDS.get(build.icon_key) : null;
    if (!icon) throw new ApiError(404, "not_found", `Build ${buildId} has no icon.`);
    return c.body(icon.body, 200, {
      "content-type": build!.icon_key!.endsWith(".webp") ? "image/webp" : "image/png",
      "cache-control": "public, max-age=3600",
      etag: icon.httpEtag,
    });
  });

  app.notFound((c) => c.json<ErrorBody>({ code: "not_found", message: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json<ErrorBody>(err.body, err.status);
    console.error(err);
    return c.json<ErrorBody>({ code: "internal", message: "Internal error" }, 500);
  });

  return app;
}

/** The ID of a confirmed Build, expired or not; 404 otherwise. */
async function existingBuild(env: Env, buildId: string): Promise<string> {
  const found = BUILD_ID.test(buildId) && (await env.DB.prepare("SELECT 1 FROM builds WHERE id = ?").bind(buildId).first());
  if (!found) throw new ApiError(404, "build_not_found", `There is no Build ${buildId}.`);
  return buildId;
}

/** Resyncs installations unless another request did within the last minute. */
async function resyncIfDue(deps: Dependencies, env: Env): Promise<boolean> {
  const github = deps.github(env);
  if (!github || !(await claimResync(env.DB, deps.now()))) return false;
  try {
    await resyncInstallations(env.DB, github, deps.allowList.owners, deps.now());
    return true;
  } catch (error) {
    console.error("Resyncing GitHub App installations failed:", error);
    return false;
  }
}

/** The Cron Trigger's work. Retention (docs/design.md#retention) is not implemented yet. */
export async function runScheduled(deps: Dependencies, env: Env): Promise<void> {
  const github = deps.github(env);
  if (github) {
    // Hourly, whatever the rate limit says; recording it keeps request-triggered resyncs spaced.
    await claimResync(env.DB, deps.now());
    await resyncInstallations(env.DB, github, deps.allowList.owners, deps.now());
  } else {
    throw new Error(`Can't resync GitHub App installations: ${gitHubAppProblem(env)}`);
  }
  // TODO: retention: delete expired Builds' files, abandoned `uploads` rows (older than the upload URL
  // lifetime) and their R2 objects, and Pull request channels 24 hours after they end.
}

// One client per App and key for the isolate's lifetime, so its JWT and installation tokens are reused.
const gitHubApps = new Map<string, GitHubApp>();

function gitHubAppProblem(env: Env): string {
  if (!lock.app) return NO_APP;
  return "the GITHUB_APP_PRIVATE_KEY secret is not set; add it with `wrangler secret put GITHUB_APP_PRIVATE_KEY`.";
}

function deploymentGitHubApp(env: Env): GitHubApp | undefined {
  const appId = lock.app?.id;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey) {
    console.warn(`The GitHub App is unavailable: ${gitHubAppProblem(env)}`);
    return undefined;
  }
  const key = `${appId}:${privateKey}`;
  let github = gitHubApps.get(key);
  if (!github) {
    github = createGitHubApp({ appId, privateKey });
    gitHubApps.set(key, github);
  }
  return github;
}

const allowList: AllowList = { owners: lock.owners, exceptions: config.repositories };

const productionDependencies: Dependencies = {
  allowList,
  allowedRepositories: (env) => installationAllowedRepositories(env.DB, allowList),
  // Module scope, so the GitHub key set is cached for the isolate's lifetime.
  verifyToken: createTokenVerifier({ audience: config.url }),
  presigner: (env) =>
    r2Presigner({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET_NAME,
    }),
  github: deploymentGitHubApp,
  now: Date.now,
};

export const app = createApp(productionDependencies);

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduled(productionDependencies, env));
  },
} satisfies ExportedHandler<Env>;
