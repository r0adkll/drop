import { Hono, type Context } from "hono";
import { installationAllowedRepositories, type AllowedRepositories, type AllowList } from "./allowed-repositories";
import { config, indexPagesEnabled, lock } from "./config";
import { ApiError, type ErrorBody } from "./errors";
import type { components } from "./generated/openapi";
import { handlePullRequestEvent, handleWebhook, verifyWebhookSignature, WebhookPayloadError } from "./github-webhook";
import { createGitHubApp, NO_APP, type GitHubApp } from "./github/client";
import { postCommitComment } from "./github/commit-comment";
import { claimResync, resyncInstallations } from "./github/installations";
import { noteDeletedBuilds, updatePullRequestComment, type CommentTarget } from "./github/pull-request-comment";
import { createTokenVerifier, type GitHubClaims, type TokenVerifier } from "./oidc";
import { r2Presigner, type Presigner } from "./presign";
import { loadBuildPage } from "./build-page/model";
import { PAGE_SCRIPT, renderBuildPage } from "./build-page/render";
import { serveDownload } from "./download";
import { loadChannelPage, loadIndex, loadProductPage } from "./site-pages/model";
import { renderChannelPage, renderIndex, renderProductPage } from "./site-pages/render";
import { DROP_ICON_SVG } from "./icon";
import { sendBuildWebhooks } from "./notifications";
import { qrPng, qrSvg } from "./qr";
import { applyRetention } from "./retention-job";
import { checkForUpdate, parseUpdateCheck } from "./update-check";
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
  /** The fetch outgoing webhooks use; tests replace it. */
  webhookFetch?: typeof fetch;
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

  app.get("/favicon.svg", (c) => c.body(DROP_ICON_SVG, 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" }));

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
    // Only a Build's first confirmation goes to webhooks; a later attempt of its run posts nothing.
    const isNew = !(await c.env.DB.prepare("SELECT 1 FROM builds WHERE id = ?").bind(buildId).first());
    const uploaded = await completeUpload({ env: c.env, claims, now: deps.now(), waitUntil: waitUntil(c) }, buildId);
    waitUntil(c)(announceBuild(deps, c.env, buildId, claims.repositoryOwnerId));
    if (isNew) {
      waitUntil(c)(
        sendBuildWebhooks(c.env as unknown as Record<string, unknown> & { DB: D1Database }, config.url, buildId, { fetch: deps.webhookFetch }).catch((error: unknown) => {
          console.error(`Sending webhooks for Build ${buildId} failed:`, error);
        }),
      );
    }
    return c.json(uploaded);
  });

  app.get("/api/v1/update", async (c) => {
    const installed = parseUpdateCheck(new URL(c.req.url).searchParams);
    const answer = await checkForUpdate(c.env.DB, installed, deps.now());
    return c.json(answer, 200, { "cache-control": "no-store" });
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
      const event = c.req.header("x-github-event") ?? "";
      if (event === "pull_request") {
        const { outcome, comment } = await handlePullRequestEvent(c.env.DB, deps.allowList.owners, payload, deps.now());
        if (comment) waitUntil(c)(refreshComment(deps, c.env, comment));
        return c.json<WebhookResult>({ result: outcome });
      }
      const result = await handleWebhook(c.env.DB, deps.allowList.owners, event, payload, deps.now());
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

  // For chat apps that don't render SVG (docs/design.md#notifications).
  app.get("/b/:buildId/qr.png", async (c) => {
    const buildId = await existingBuild(c.env, c.req.param("buildId"));
    return c.body(await qrPng(buildUrl(buildId)), 200, {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  // Icons outlive their Build's file (docs/design.md#retention). A later attempt of the run may
  // bring a new icon under the same ID, so they are cached for an hour, not forever.
  app.get("/b/:buildId/icon", async (c) => {
    const buildId = c.req.param("buildId");
    const build = BUILD_ID.test(buildId)
      ? await c.env.DB.prepare("SELECT application_id, icon_key FROM builds WHERE id = ?").bind(buildId).first<{ application_id: string; icon_key: string | null }>()
      : null;
    // A Product's configured icon replaces the APK's, served from here so Build pages stay same-origin.
    const override = build && config.products?.[build.application_id]?.icon;
    if (override) {
      const upstream = await fetch(override, { cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!upstream.ok || !upstream.body) throw new ApiError(404, "not_found", `Build ${buildId}'s configured icon is unavailable.`);
      return c.body(upstream.body, 200, {
        "content-type": upstream.headers.get("content-type") ?? "image/png",
        "cache-control": "public, max-age=3600",
      });
    }
    const icon = build?.icon_key ? await c.env.BUILDS.get(build.icon_key) : null;
    if (!icon) throw new ApiError(404, "not_found", `Build ${buildId} has no icon.`);
    return c.body(icon.body, 200, {
      "content-type": build!.icon_key!.endsWith(".webp") ? "image/webp" : "image/png",
      "cache-control": "public, max-age=3600",
      etag: icon.httpEtag,
    });
  });

  // The Build page (docs/design.md#build-pages). Every state renders here: available, expired, private
  // and unknown, so a link always lands on a page rather than an error body.
  // The index, Product and Channel pages (docs/design.md#site-pages). The index and Product pages
  // can be turned off in config; Channel pages stay reachable by link.
  const sitePage = async (c: Context<{ Bindings: Env }>, page: { status: number; html: string }) =>
    c.html(page.html, page.status as 200 | 403 | 404, {
      "cache-control": "public, max-age=60",
      "content-security-policy": await pageContentSecurityPolicy(),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    });
  const notFound = (c: Context<{ Bindings: Env }>) => sitePage(c, renderChannelPage({ kind: "not_found" }, { baseUrl: config.url }));

  app.get("/", async (c) => {
    if (!indexPagesEnabled()) return notFound(c);
    return sitePage(c, renderIndex(await loadIndex(c.env.DB), { baseUrl: config.url }));
  });

  app.get("/p/:applicationId", async (c) => {
    if (!indexPagesEnabled()) return notFound(c);
    return sitePage(c, renderProductPage(await loadProductPage(c.env.DB, c.req.param("applicationId")), { baseUrl: config.url }));
  });

  app.get("/p/:applicationId/c/*", async (c) => {
    const applicationId = c.req.param("applicationId");
    const prefix = `/p/${encodeURIComponent(applicationId)}/c/`;
    const path = new URL(c.req.url).pathname;
    if (!path.startsWith(prefix)) return notFound(c);
    let channel: string;
    try {
      channel = path.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    } catch {
      return notFound(c);
    }
    return sitePage(c, renderChannelPage(await loadChannelPage(c.env.DB, applicationId, channel), { baseUrl: config.url }));
  });

  app.get("/b/:buildId", async (c) => {
    const page = renderBuildPage(await loadBuildPage(c.env.DB, c.req.param("buildId")), { baseUrl: config.url });
    return c.html(page.html, page.status, {
      "cache-control": "public, max-age=60",
      "content-security-policy": await pageContentSecurityPolicy(),
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex",
    });
  });

  app.on(["GET", "HEAD"], "/b/:buildId/download", (c) => serveDownload(c.env, c.req.param("buildId"), c.req.raw));

  app.notFound((c) => c.json<ErrorBody>({ code: "not_found", message: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json<ErrorBody>(err.body, err.status);
    console.error(err);
    return c.json<ErrorBody>({ code: "internal", message: "Internal error" }, 500);
  });

  return app;
}

/** Brings a pull request's comment up to date, logging rather than failing the request. */
async function refreshComment(deps: Dependencies, env: Env, target: CommentTarget): Promise<void> {
  const github = deps.github(env);
  if (!github) return;
  try {
    await updatePullRequestComment(env.DB, github, config.url, target);
  } catch (error) {
    console.error(`Updating the comment on ${target.repository}#${target.pullRequest} failed:`, error);
  }
}

let contentSecurityPolicy: Promise<string> | undefined;

/** Nothing but the page itself: inline styles, its one script by hash, and same-origin images. */
function pageContentSecurityPolicy(): Promise<string> {
  contentSecurityPolicy ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(PAGE_SCRIPT)).then((digest) => {
    const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
    return [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `script-src 'sha256-${hash}'`,
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
  });
  return contentSecurityPolicy;
}

/**
 * Announces a newly confirmed Build: in its pull request's comment on a Pull request channel, with a
 * comment on its commit otherwise (docs/design.md#commit-comments).
 */
async function announceBuild(deps: Dependencies, env: Env, buildId: string, ownerId: number): Promise<void> {
  const github = deps.github(env);
  if (!github) return;
  const build = await env.DB
    .prepare(
      `SELECT c.pull_request, p.repository_id, p.repository FROM builds b
       JOIN channels c ON c.id = b.channel_id JOIN products p ON p.application_id = b.application_id WHERE b.id = ?`,
    )
    .bind(buildId)
    .first<{ pull_request: number | null; repository_id: number; repository: string }>();
  if (!build) return;
  const installation = await env.DB.prepare("SELECT id FROM installations WHERE account_id = ?").bind(ownerId).first<{ id: number }>();
  if (!installation) {
    console.warn(`No installation recorded for ${build.repository}'s owner, so its Build can't be announced on GitHub.`);
    return;
  }
  if (build.pull_request !== null) {
    await refreshComment(deps, env, {
      repositoryId: build.repository_id,
      repository: build.repository,
      pullRequest: build.pull_request,
      installationId: installation.id,
    });
    return;
  }
  try {
    const outcome = await postCommitComment(env.DB, github, config.url, buildId, installation.id, deps.now());
    if (outcome === "not_permitted") {
      console.warn(`The GitHub App can't comment on ${build.repository}'s commits: its installation hasn't accepted Contents read (ADR 0010).`);
    }
  } catch (error) {
    console.error(`Commenting on Build ${buildId}'s commit failed:`, error);
  }
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
  const failures: unknown[] = [];
  const attempt = async (step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  };

  await attempt(async () => {
    const result = await applyRetention(env.DB, env.BUILDS, deps.now());
    if (result.expiredBuilds.length > 0 || result.abandonedUploads > 0 || result.deletedObjects > 0) {
      console.log(
        `Retention: ${result.expiredBuilds.length} Builds expired, ${result.abandonedUploads} abandoned uploads dropped, ${result.deletedObjects} files deleted.`,
      );
    }
  });

  const github = deps.github(env);
  if (github) {
    await attempt(async () => {
      // Hourly, whatever the rate limit says; recording it keeps request-triggered resyncs spaced.
      await claimResync(env.DB, deps.now());
      await resyncInstallations(env.DB, github, deps.allowList.owners, deps.now());
    });
    await attempt(async () => {
      await noteDeletedBuilds(env.DB, github, deps.now());
    });
  } else {
    failures.push(new Error(`Can't resync GitHub App installations or edit pull request comments: ${gitHubAppProblem(env)}`));
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, failures.map((failure) => (failure instanceof Error ? failure.message : String(failure))).join("; "));
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
