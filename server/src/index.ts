import { Hono, type Context } from "hono";
import { installationAllowedRepositories, type AllowedRepositories, type AllowList } from "./allowed-repositories";
import { config, lock } from "./config";
import { ApiError, type ErrorBody } from "./errors";
import type { components } from "./generated/openapi";
import { handleWebhook, verifyWebhookSignature, WebhookPayloadError } from "./github-webhook";
import { createTokenVerifier, type GitHubClaims, type TokenVerifier } from "./oidc";
import { r2Presigner, type Presigner } from "./presign";
import { completeUpload, createUpload, parseCreateUpload } from "./uploads";

type Health = components["schemas"]["Health"];
type WebhookResult = components["schemas"]["WebhookResult"];

export interface Dependencies {
  /** Listed Owners and repository exceptions, from the config and its lockfile. */
  allowList: AllowList;
  allowedRepositories: (env: Env) => AllowedRepositories;
  verifyToken: TokenVerifier;
  presigner: (env: Env) => Presigner;
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

  app.notFound((c) => c.json<ErrorBody>({ code: "not_found", message: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json<ErrorBody>(err.body, err.status);
    console.error(err);
    return c.json<ErrorBody>({ code: "internal", message: "Internal error" }, 500);
  });

  return app;
}

const allowList: AllowList = { owners: lock.owners, exceptions: config.repositories };

export const app = createApp({
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
  now: Date.now,
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, _env, _ctx) {
    // Retention (docs/design.md#retention) is not implemented yet.
    // TODO: also delete abandoned `uploads` rows (older than the upload URL lifetime) and their R2
    // objects, which completeUpload never reached.
  },
} satisfies ExportedHandler<Env>;
