import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Badging {
  packageName: string;
  versionCode: number;
  versionName?: string;
  label?: string;
  /** `wear` when the APK requires a watch (ADR 0017), `mobile` otherwise. */
  formFactor: "mobile" | "wear";
  /** Launcher icon paths inside the APK by screen density. */
  icons: { density: number; path: string }[];
}

const ATTRIBUTE = /(\w+)='((?:[^'\\]|\\.)*)'/g;
const unescape = (value: string) => value.replace(/\\(.)/g, "$1");

/** Parses `aapt2 dump badging <apk>` output. */
export function parseBadging(output: string): Badging {
  let packageName: string | undefined;
  let versionCode: number | undefined;
  let versionName: string | undefined;
  let label: string | undefined;
  let fallbackLabel: string | undefined;
  let formFactor: Badging["formFactor"] = "mobile";
  const icons: Badging["icons"] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("package: ")) {
      for (const [, key, raw] of line.matchAll(ATTRIBUTE)) {
        const value = unescape(raw!);
        if (key === "name") packageName = value;
        if (key === "versionCode") versionCode = Number(value);
        if (key === "versionName" && value !== "") versionName = value;
      }
      continue;
    }
    const labelMatch = /^application-label:'((?:[^'\\]|\\.)*)'$/.exec(line);
    if (labelMatch) {
      label = unescape(labelMatch[1]!);
      continue;
    }
    const iconMatch = /^application-icon-(\d+):'((?:[^'\\]|\\.)*)'$/.exec(line);
    if (iconMatch) {
      icons.push({ density: Number(iconMatch[1]), path: unescape(iconMatch[2]!) });
      continue;
    }
    // A required feature; one declared with required="false" prints as uses-feature-not-required.
    if (/^\s*uses-feature: name='android\.hardware\.type\.watch'/.test(line)) {
      formFactor = "wear";
      continue;
    }
    if (line.startsWith("application: ")) {
      for (const [, key, raw] of line.matchAll(ATTRIBUTE)) if (key === "label" && raw) fallbackLabel = unescape(raw);
    }
  }

  if (!packageName) throw new Error("aapt2 reported no package name; is this an APK?");
  if (versionCode === undefined || !Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error("aapt2 reported no valid versionCode.");
  }
  return { packageName, versionCode, versionName, label: label || fallbackLabel, formFactor, icons };
}

/**
 * A signer line from `apksigner verify --print-certs`, which prints only the newest scheme's signers:
 * `Signer #1 certificate …` up to build-tools 36, `V2 Signer: certificate …` or `V2 Signer #1:
 * certificate …` from 37. A key rotated with a v3.1 lineage prints one signer per SDK range, as
 * `Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate …` or `V3.1 Signer: (…) certificate …`.
 */
const SIGNER_DIGEST = /^(?:V[\d.]+ )?Signer(?: #\d+)?:?(?: \(minSdkVersion=\d+, maxSdkVersion=(\d+)\))? certificate SHA-256 digest: ([0-9a-fA-F]{64})$/gm;

/**
 * Parses `apksigner verify --print-certs <apk>` output into the signing certificate's SHA-256. For a
 * rotated key this is the current one, the signer for the newest SDK range.
 */
export function parseSignerDigest(output: string): string {
  const signers = [...output.matchAll(SIGNER_DIGEST)].map((match) => ({
    maxSdk: match[1] === undefined ? undefined : Number(match[1]),
    digest: match[2]!.toLowerCase(),
  }));
  if (signers.length === 0) throw new Error("apksigner found no signing certificate. Drop needs a signed APK.");
  if (signers.every((signer) => signer.maxSdk !== undefined)) {
    return signers.reduce((newest, signer) => (signer.maxSdk! > newest.maxSdk! ? signer : newest)).digest;
  }
  const digests = new Set(signers.map((signer) => signer.digest));
  if (digests.size > 1) throw new Error("The APK has more than one signer; Drop supports one signing certificate per Build.");
  return [...digests][0]!;
}

/**
 * The bitmap icon with the highest density. Densities 65534 and 65535 (anydpi) and adaptive-icon
 * XML have no bitmap, so they are skipped.
 */
export function pickIcon(icons: Badging["icons"]): { path: string; contentType: "image/png" | "image/webp" } | undefined {
  const best = icons
    .filter((icon) => icon.density < 65534 && /\.(png|webp)$/i.test(icon.path))
    .sort((a, b) => b.density - a.density)[0];
  if (!best) return undefined;
  return { path: best.path, contentType: /\.png$/i.test(best.path) ? "image/png" : "image/webp" };
}

/** Finds `aapt2` and `apksigner` in the newest build-tools version that has both. */
export function findBuildTools(androidHome: string | undefined): { aapt2: string; apksigner: string } {
  if (!androidHome) throw new Error("ANDROID_HOME is not set. Drop needs the Android SDK build tools (GitHub's Ubuntu runners include them).");
  const root = join(androidHome, "build-tools");
  const versions = existsSync(root) ? readdirSync(root).sort(compareVersionsDescending) : [];
  for (const version of versions) {
    const aapt2 = join(root, version, "aapt2");
    const apksigner = join(root, version, "apksigner");
    if (existsSync(aapt2) && existsSync(apksigner)) return { aapt2, apksigner };
  }
  throw new Error(`No build-tools version under ${root} has both aapt2 and apksigner.`);
}

function compareVersionsDescending(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre] = v.split("-", 2);
    return { parts: main.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const diff = (y.parts[i] ?? 0) - (x.parts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A release sorts before its own pre-releases (36.0.0 before 36.0.0-rc1).
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return -1;
  if (y.pre === undefined) return 1;
  return y.pre.localeCompare(x.pre);
}
