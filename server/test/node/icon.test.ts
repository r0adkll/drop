import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_LOGO } from "../../scripts/setup-stages.ts";
import { DROP_ICON_SVG } from "../../src/icon.ts";

const asset = (name: string) => readFileSync(new URL(`../../../docs/assets/${name}`, import.meta.url), "utf8").trim();

describe("Drop's icon", () => {
  it("is served exactly as docs/assets/drop-icon.svg draws it", () => {
    expect(DROP_ICON_SVG).toBe(asset("drop-icon.svg"));
  });

  it("has a square App logo that differs only in its corners", () => {
    expect(asset("drop-app-logo.svg")).toBe(asset("drop-icon.svg").replace(' rx="22"', ""));
    expect(existsSync(APP_LOGO)).toBe(true);
  });
});
