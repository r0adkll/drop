import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { components } from "./generated/openapi";

export type ErrorCode = components["schemas"]["ErrorCode"];
export type ErrorBody = components["schemas"]["Error"];

/** A failure the API reports as an `Error` body with a stable code. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }

  get body(): ErrorBody {
    return { code: this.code, message: this.message };
  }
}
