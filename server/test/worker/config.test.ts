import { describe, expect, it } from "vitest";
import { config } from "../../src/config";

describe("config", () => {
  it("is bundled into the Worker", () => {
    expect(config.url).toBe("https://drop.example.com");
  });
});
