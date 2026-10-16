import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, openAsBlob, readFileSync, statSync } from "node:fs";
import * as core from "@actions/core";
import { unzipSync } from "fflate";
import { adaptiveIconSvg, parseResourceTable, parseXmlTree, UnsupportedIcon } from "./adaptive-icon.ts";
import { findBuildTools, parseBadging, parseSignerDigest, pickIcon } from "./apk-tools.ts";
import { readCommitMessage } from "./git.ts";
import { renderSvg, webpToPng } from "./raster.ts";
import { chooseChannel, commitDetails, namedChannel, type EventPayload, type RunContext } from "./run-context.ts";
import { upload, type CreateUploadRequest } from "./upload.ts";

const MAX_ICON_BYTES = 1024 * 1024;

async function main(): Promise<void> {
  const server = serverOrigin(core.getInput("server", { required: true }));
  const apkPath = core.getInput("apk", { required: true });
  const iconInput = core.getInput("icon") || undefined;
  if (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    throw new Error("No OIDC token is available. Give the job `permissions: id-token: write` so Drop can verify which repository and run the Build came from.");
  }

  const tools = findBuildTools(process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT);
  const badging = parseBadging(run(tools.aapt2, ["dump", "badging", apkPath]));
  const signerSha256 = parseSignerDigest(run(tools.apksigner, ["verify", "--print-certs", apkPath]));

  const runContext = readRunContext();
  const named = namedChannel(core.getInput("channel") || undefined, process.env.DROP_CHANNEL || undefined);
  if (named.warning) core.warning(named.warning);
  const { channel, defaultBranch } = chooseChannel(runContext, named.channel);
  const commit = commitDetails(runContext, gitMessage);

  const icon = await readIcon(apkPath, iconInput, badging.icons, tools.aapt2);
  const request: CreateUploadRequest = {
    applicationId: badging.packageName,
    versionCode: badging.versionCode,
    versionName: badging.versionName,
    label: badging.label,
    signerSha256,
    apk: { size: statSync(apkPath).size, sha256: await sha256File(apkPath) },
    ...(icon ? { icon: { size: icon.bytes.length, sha256: sha256Bytes(icon.bytes), contentType: icon.contentType } } : {}),
    channel,
    defaultBranch,
    commit: { sha: commit.sha, message: commit.message },
    pullRequestTitle: commit.pullRequestTitle,
  };
  const version = request.versionName ? `${request.versionName} (${request.versionCode})` : `(${request.versionCode})`;
  core.info(`Uploading ${request.label ?? request.applicationId} ${version} to ${channel}`);

  const token = await core.getIDToken(server);

  const build = await upload(server, token, request, {
    apk: await openAsBlob(apkPath),
    icon: icon ? new Blob([icon.bytes], { type: icon.contentType }) : undefined,
  });
  core.setOutput("build-id", build.buildId);
  core.setOutput("build-url", build.buildUrl);
  core.notice(`Drop Build page: ${build.buildUrl}`);
}

function serverOrigin(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error(`The server input must be an https URL, not ${input}.`);
  // The origin is the token's audience, which must equal the deployment's configured URL.
  return url.origin;
}

function run(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`${file} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
}

function readRunContext(): RunContext {
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set; the Drop action runs only in GitHub Actions.`);
    return value;
  };
  return {
    eventName: env("GITHUB_EVENT_NAME"),
    ref: env("GITHUB_REF"),
    refName: env("GITHUB_REF_NAME"),
    sha: env("GITHUB_SHA"),
    payload: JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")) as EventPayload,
  };
}

function gitMessage(sha: string): string | undefined {
  return readCommitMessage(
    (args, timeoutMs) =>
      execFileSync("git", args, {
        cwd: process.env.GITHUB_WORKSPACE,
        encoding: "utf8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    sha,
  );
}

async function readIcon(apkPath: string, iconInput: string | undefined, icons: ReturnType<typeof parseBadging>["icons"], aapt2: string) {
  let icon: { bytes: Uint8Array; contentType: "image/png" | "image/webp" } | undefined;
  if (iconInput) {
    const contentType = /\.png$/i.test(iconInput) ? "image/png" : /\.webp$/i.test(iconInput) ? "image/webp" : undefined;
    if (!contentType) throw new Error(`The icon input must be a .png or .webp file, not ${iconInput}.`);
    icon = { bytes: readFileSync(iconInput), contentType };
  } else {
    const picked = pickIcon(icons);
    if (!picked) return drawAdaptiveIcon(apkPath, icons, aapt2);
    const bytes = unzipSync(readFileSync(apkPath), { filter: (file) => file.name === picked.path })[picked.path];
    if (!bytes) {
      core.warning(`The APK has no ${picked.path}; uploading without an icon.`);
      return undefined;
    }
    icon = { bytes, contentType: picked.contentType };
  }
  if (icon.bytes.length > MAX_ICON_BYTES) {
    core.warning(`The icon is ${icon.bytes.length} bytes, over Drop's 1 MB limit; uploading without it.`);
    return undefined;
  }
  return icon;
}

/** Renders an adaptive launcher icon to PNG; any failure leaves the Build without an icon. */
async function drawAdaptiveIcon(apkPath: string, icons: ReturnType<typeof parseBadging>["icons"], aapt2: string) {
  const path = icons.filter((icon) => /\.xml$/i.test(icon.path)).sort((a, b) => b.density - a.density)[0]?.path;
  if (!path) {
    core.info("The APK has no launcher icon; set the icon input to show one.");
    return undefined;
  }
  try {
    const apk = readFileSync(apkPath);
    const svg = await adaptiveIconSvg(path, {
      resources: parseResourceTable(run(aapt2, ["dump", "resources", apkPath])),
      xmlTree: (file) => parseXmlTree(run(aapt2, ["dump", "xmltree", "--file", file, apkPath])),
      file: (file) => unzipSync(apk, { filter: (entry) => entry.name === file })[file],
      webpToPng,
    });
    const { png } = await renderSvg(svg);
    return { bytes: png, contentType: "image/png" as const };
  } catch (error) {
    if (error instanceof UnsupportedIcon) {
      core.info(`The APK's adaptive icon uses ${error.message}, which Drop can't draw; set the icon input to show one.`);
    } else {
      core.warning(`Drawing the APK's adaptive icon failed, so the Build has no icon: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((error: unknown) => core.setFailed(error instanceof Error ? error.message : String(error)));
