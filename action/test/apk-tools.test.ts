import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBuildTools, parseBadging, parseSignerDigest, pickIcon } from "../src/apk-tools.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseBadging", () => {
  it("reads the package, version, label and icons", () => {
    const badging = parseBadging(fixture("badging-bitmap.txt"));
    expect(badging).toMatchObject({ packageName: "com.example.trailhead", versionCode: 4127, versionName: "2.8.0", label: "Trailhead" });
    expect(badging.icons).toHaveLength(6);
    expect(badging.icons.at(-1)).toEqual({ density: 65534, path: "res/mipmap-anydpi-v26/ic_launcher.xml" });
  });

  it("unescapes quotes and drops an empty versionName", () => {
    const badging = parseBadging(fixture("badging-adaptive.txt"));
    expect(badging.label).toBe("Trailhead's Admin");
    expect(badging.versionName).toBeUndefined();
  });

  it("tells a watch APK from a mobile one by its required features", () => {
    expect(parseBadging(fixture("badging-wear.txt")).formFactor).toBe("wear");
    expect(parseBadging(fixture("badging-bitmap.txt")).formFactor).toBe("mobile");
    const optional = fixture("badging-bitmap.txt").replace("  uses-feature: name='android.hardware.faketouch'", "  uses-feature-not-required: name='android.hardware.type.watch'");
    expect(parseBadging(optional).formFactor).toBe("mobile");
  });

  it("rejects output without a package", () => {
    expect(() => parseBadging("ERROR: dump failed")).toThrow(/no package name/);
  });
});

describe("parseSignerDigest", () => {
  it("returns the signer's SHA-256", () => {
    expect(parseSignerDigest(fixture("apksigner-one.txt"))).toBe("3a9fc2417bd1e8a06f4c2259e0d7b31aa45c6e9082f17d3b5e08c4aa5de1e107");
  });

  it("reads build-tools 37's scheme-prefixed output", () => {
    expect(parseSignerDigest(fixture("apksigner-37-v2.txt"))).toBe("174c51c931d010ec1aec6ff7da82483cba386a3b0f0dd4a5be9cc01f552f30ef");
    expect(parseSignerDigest(fixture("apksigner-37-v3.txt"))).toBe("174c51c931d010ec1aec6ff7da82483cba386a3b0f0dd4a5be9cc01f552f30ef");
  });

  it("returns the current key of a rotated signer", () => {
    for (const name of ["apksigner-36-rotated.txt", "apksigner-37-rotated.txt"]) {
      expect(parseSignerDigest(fixture(name))).toBe("1f5ae1f0d3a5748e647613748a304808457f31d6b168b07a4701d09077306184");
    }
  });

  it("refuses unsigned and multi-signer APKs", () => {
    expect(() => parseSignerDigest("")).toThrow(/signed APK/);
    expect(() => parseSignerDigest(fixture("apksigner-two.txt"))).toThrow(/more than one signer/);
    expect(() => parseSignerDigest(fixture("apksigner-37-two.txt"))).toThrow(/more than one signer/);
  });
});

describe("pickIcon", () => {
  it("picks the highest-density bitmap", () => {
    expect(pickIcon(parseBadging(fixture("badging-bitmap.txt")).icons)).toEqual({ path: "res/mipmap-xxxhdpi-v4/ic_launcher.png", contentType: "image/png" });
  });

  it("finds nothing when the icon is adaptive XML only", () => {
    expect(pickIcon(parseBadging(fixture("badging-adaptive.txt")).icons)).toBeUndefined();
  });

  it("accepts WebP", () => {
    expect(pickIcon([{ density: 480, path: "res/a.webp" }])).toEqual({ path: "res/a.webp", contentType: "image/webp" });
  });
});

describe("findBuildTools", () => {
  function sdk(versions: Record<string, string[]>): string {
    const home = mkdtempSync(join(tmpdir(), "android-sdk-"));
    for (const [version, files] of Object.entries(versions)) {
      mkdirSync(join(home, "build-tools", version), { recursive: true });
      for (const file of files) writeFileSync(join(home, "build-tools", version, file), "");
    }
    return home;
  }

  it("uses the newest version that has both tools", () => {
    const home = sdk({ "34.0.0": ["aapt2", "apksigner"], "35.0.1": ["aapt2", "apksigner"], "36.0.0-rc1": ["aapt2"], "9.0.0": ["aapt2", "apksigner"] });
    expect(findBuildTools(home)).toEqual({ aapt2: join(home, "build-tools", "35.0.1", "aapt2"), apksigner: join(home, "build-tools", "35.0.1", "apksigner") });
  });

  it("prefers a release over its release candidate", () => {
    const home = sdk({ "36.0.0-rc1": ["aapt2", "apksigner"], "36.0.0": ["aapt2", "apksigner"] });
    expect(findBuildTools(home).aapt2).toBe(join(home, "build-tools", "36.0.0", "aapt2"));
  });

  it("explains a missing SDK", () => {
    expect(() => findBuildTools(undefined)).toThrow(/ANDROID_HOME/);
    expect(() => findBuildTools(sdk({}))).toThrow(/aapt2 and apksigner/);
  });
});
