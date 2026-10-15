import { Hono } from "hono";
import type { components } from "./generated/openapi";

type Health = components["schemas"]["Health"];
type ApiError = components["schemas"]["Error"];

export const app = new Hono<{ Bindings: Env }>();

app.get("/api/v1/health", (c) => c.json<Health>({ status: "ok" }));

app.notFound((c) => c.json<ApiError>({ code: "not_found", message: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json<ApiError>({ code: "internal", message: "Internal error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller, _env, _ctx) {
    // Retention (docs/design.md#retention) is not implemented yet.
  },
} satisfies ExportedHandler<Env>;
