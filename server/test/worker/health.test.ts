import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /api/v1/health", () => {
  it("answers ok", async () => {
    const response = await exports.default.fetch("https://drop.example.com/api/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("unknown routes", () => {
  it("answer with an Error", async () => {
    const response = await exports.default.fetch("https://drop.example.com/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found", message: "Not found" });
  });
});
