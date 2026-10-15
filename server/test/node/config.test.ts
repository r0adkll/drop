import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { configErrors } from "../../scripts/validate-config.ts";

const placeholder = JSON.parse(readFileSync(new URL("../../../drop.config.json", import.meta.url), "utf8"));

describe("drop.config.schema.json", () => {
  it("accepts the placeholder config", () => {
    expect(configErrors(placeholder)).toEqual([]);
  });

  it("accepts every documented option", () => {
    expect(
      configErrors({
        url: "https://drop.example.com",
        repositories: [
          "your-org",
          "you/app",
          { repository: "you/other-app", allowEvents: ["pull_request_target"] },
        ],
        webhooks: {
          "team-slack": { format: "slack", channels: ["main", "pr/*"] },
          ci: { format: "json", products: ["com.example.app"] },
        },
        products: {
          "com.example.app": {
            private: true,
            displayName: "Example",
            icon: "https://drop.example.com/icon.png",
            retention: { buildDays: 60 },
          },
        },
      }),
    ).toEqual([]);
  });

  it("accepts an empty repositories list, which accepts no uploads", () => {
    expect(configErrors({ url: "https://drop.example.com", repositories: [] })).toEqual([]);
  });

  it.each([
    ["an empty config", {}],
    ["a missing repositories list", { url: "https://drop.example.com" }],
    ["a non-https url", { url: "http://drop.example.com", repositories: [] }],
    ["a url with a path", { url: "https://drop.example.com/drop", repositories: [] }],
    ["a malformed repository", { url: "https://drop.example.com", repositories: ["a/b/c"] }],
    [
      "an unknown event allowance",
      { url: "https://drop.example.com", repositories: [{ repository: "you/app", allowEvents: ["push"] }] },
    ],
    [
      "forcing a Product public",
      { url: "https://drop.example.com", repositories: [], products: { "com.example.app": { private: false } } },
    ],
    [
      "an unknown webhook format",
      { url: "https://drop.example.com", repositories: [], webhooks: { hook: { format: "teams" } } },
    ],
    ["an unknown key", { url: "https://drop.example.com", repositories: [], extra: true }],
  ])("rejects %s", (_, value) => {
    expect(configErrors(value)).not.toEqual([]);
  });
});
