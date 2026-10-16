// Outgoing webhooks when a Build lands (docs/design.md#notifications): a Slack or Discord message
// matching the agreed mockups, or the Build record as signed JSON. Each Build is announced once;
// a later attempt of its run posts nothing.

import { isPublicProduct } from "./build-page/model";
import { formatSize } from "./build-page/render";
import { config, type Webhook } from "./config";
import { describeChange } from "./headline";

export interface AnnouncedBuild {
  id: string;
  applicationId: string;
  name: string;
  versionName: string | null;
  versionCode: number;
  channel: string;
  isDefaultChannel: boolean;
  pullRequest: number | null;
  repository: string;
  commitSha: string;
  headline: string;
  workflow: string;
  runNumber: number;
  runId: number;
  fileSize: number;
  fileSha256: string;
  uploadedAt: number;
  hasIcon: boolean;
}

/**
 * Whether a webhook covers a Channel: its patterns (`main`, `pr/*`, `*`), or, without any, only the
 * Product's default Channel, so pull request pushes don't flood a webhook that didn't ask for them.
 */
export function coversChannel(patterns: string[] | undefined, channel: string, isDefault: boolean): boolean {
  if (!patterns) return isDefault;
  return patterns.some((pattern) => (pattern.endsWith("*") ? channel.startsWith(pattern.slice(0, -1)) : channel === pattern));
}

/** The Worker secret holding a webhook's URL: WEBHOOK_<NAME>, upper-cased, dashes as underscores. */
export function secretName(webhook: string, suffix = ""): string {
  return `WEBHOOK_${webhook.toUpperCase().replace(/-/g, "_")}${suffix}`;
}

const title = (build: AnnouncedBuild) => `${build.name} ${build.versionName ? `${build.versionName} (${build.versionCode})` : `(${build.versionCode})`}`;
const page = (baseUrl: string, build: AnnouncedBuild) => `${baseUrl}/b/${build.id}`;
const commitUrl = (build: AnnouncedBuild) => `https://github.com/${build.repository}/commit/${build.commitSha}`;
const runUrl = (build: AnnouncedBuild) => `https://github.com/${build.repository}/actions/runs/${build.runId}`;

/** Slack's mrkdwn treats &, < and > as control characters; escaping them also stops mentions. */
const slackEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function slackMessage(baseUrl: string, build: AnnouncedBuild): unknown {
  const url = page(baseUrl, build);
  const text =
    `*<${url}|${slackEscape(title(build))}>* is on \`${slackEscape(build.channel)}\`\n` +
    `${slackEscape(build.headline)}\n` +
    `<${commitUrl(build)}|${build.commitSha.slice(0, 7)}> · <${runUrl(build)}|${slackEscape(build.workflow)} #${build.runNumber}> · ${formatSize(build.fileSize)}`;
  return {
    text: `${title(build)} is on ${build.channel}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: text.slice(0, 3000) },
        ...(build.hasIcon ? { accessory: { type: "image", image_url: `${url}/icon`, alt_text: build.name } } : {}),
      },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open Build page" }, url, style: "primary" }] },
      { type: "image", image_url: `${url}/qr.png`, alt_text: "QR code for the Build page", title: { type: "plain_text", text: "Scan to install" } },
    ],
  };
}

/** Discord markdown, escaped so upload text renders as typed. */
const discordEscape = (text: string) => text.replace(/[\\*_~`|>[\]()#-]/g, "\\$&");

export function discordMessage(baseUrl: string, build: AnnouncedBuild): unknown {
  const url = page(baseUrl, build);
  return {
    username: "Drop",
    // Text from an upload must never ping anyone.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `${title(build)} on ${build.channel}`.slice(0, 256),
        url,
        description: discordEscape(build.headline).slice(0, 4000),
        color: 0x2f6b4f,
        fields: [
          { name: "Commit", value: `[${build.commitSha.slice(0, 7)}](${commitUrl(build)})`, inline: true },
          { name: "CI run", value: `[${discordEscape(build.workflow)} #${build.runNumber}](${runUrl(build)})`.slice(0, 1024), inline: true },
          { name: "Size", value: formatSize(build.fileSize), inline: true },
        ],
        ...(build.hasIcon ? { thumbnail: { url: `${url}/icon` } } : {}),
        image: { url: `${url}/qr.png` },
        footer: { text: `Scan to install · ${build.repository}` },
        timestamp: new Date(build.uploadedAt).toISOString(),
      },
    ],
  };
}

/** The Build record for `json` webhooks. */
export function jsonPayload(baseUrl: string, build: AnnouncedBuild): unknown {
  const url = page(baseUrl, build);
  return {
    event: "build.uploaded",
    build: {
      buildId: build.id,
      buildUrl: url,
      applicationId: build.applicationId,
      label: build.name,
      versionName: build.versionName,
      versionCode: build.versionCode,
      channel: build.channel,
      pullRequest: build.pullRequest,
      repository: build.repository,
      commitSha: build.commitSha,
      headline: build.headline,
      run: { id: build.runId, number: build.runNumber, workflow: build.workflow },
      fileSize: build.fileSize,
      fileSha256: build.fileSha256,
      uploadedAt: new Date(build.uploadedAt).toISOString(),
      iconUrl: build.hasIcon ? `${url}/icon` : null,
      qrUrl: `${url}/qr.png`,
    },
  };
}

export async function loadAnnouncedBuild(db: D1Database, buildId: string): Promise<{ build: AnnouncedBuild; isPublic: boolean } | undefined> {
  const row = await db
    .prepare(
      `SELECT b.id, b.application_id, b.label, b.version_name, b.version_code, c.name AS channel, c.is_default, c.pull_request,
         p.repository, p.repository_visibility, b.commit_sha, b.commit_message, b.pull_request_title, b.release_notes, b.workflow, b.run_number,
         b.run_id, b.file_size, b.file_sha256, b.uploaded_at, b.icon_key
       FROM builds b JOIN channels c ON c.id = b.channel_id JOIN products p ON p.application_id = b.application_id WHERE b.id = ?`,
    )
    .bind(buildId)
    .first<{
      id: string; application_id: string; label: string | null; version_name: string | null; version_code: number; channel: string;
      is_default: number; pull_request: number | null; repository: string; repository_visibility: string; commit_sha: string;
      commit_message: string | null; pull_request_title: string | null; release_notes: string | null; workflow: string; run_number: number; run_id: number;
      file_size: number; file_sha256: string; uploaded_at: number; icon_key: string | null;
    }>();
  if (!row) return undefined;
  const overrides = config.products?.[row.application_id];
  const name = overrides?.displayName ?? row.label ?? row.application_id;
  const { headline, commitLine } = describeChange(row, name);
  return {
    isPublic: isPublicProduct(row.application_id, row.repository_visibility),
    build: {
      id: row.id,
      applicationId: row.application_id,
      name,
      versionName: row.version_name,
      versionCode: row.version_code,
      channel: row.channel,
      isDefaultChannel: row.is_default === 1,
      pullRequest: row.pull_request,
      repository: row.repository,
      commitSha: row.commit_sha,
      headline,
      workflow: row.workflow,
      runNumber: row.run_number,
      runId: row.run_id,
      fileSize: row.file_size,
      fileSha256: row.file_sha256,
      uploadedAt: row.uploaded_at,
      hasIcon: row.icon_key !== null || overrides?.icon !== undefined,
    },
  };
}

export interface SendOptions {
  fetch?: typeof fetch;
  /** Waits between attempts; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  webhooks?: Record<string, Webhook>;
}

const RETRY_DELAYS_MS = [1_000, 4_000];

/**
 * Sends a newly confirmed Build to every webhook that covers it. A failed delivery (network, 429 or
 * 5xx) is retried twice, then logged; nothing here fails the upload. Returns the webhooks delivered.
 */
export async function sendBuildWebhooks(env: Record<string, unknown> & { DB: D1Database }, baseUrl: string, buildId: string, options: SendOptions = {}): Promise<string[]> {
  const webhooks = options.webhooks ?? config.webhooks ?? {};
  if (Object.keys(webhooks).length === 0) return [];
  const loaded = await loadAnnouncedBuild(env.DB, buildId);
  if (!loaded) return [];
  // Private products reveal nothing outside sign-in, as their Build pages don't (ADR 0010).
  if (!loaded.isPublic) return [];
  const { build } = loaded;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const delivered: string[] = [];
  await Promise.all(
    Object.entries(webhooks).map(async ([name, webhook]) => {
      if (webhook.products && !webhook.products.includes(build.applicationId)) return;
      if (!coversChannel(webhook.channels, build.channel, build.isDefaultChannel)) return;
      const url = env[secretName(name)];
      if (typeof url !== "string" || !url) {
        console.warn(`Webhook ${name} has no ${secretName(name)} secret; skipping Build ${build.id}.`);
        return;
      }
      const payload = webhook.format === "slack" ? slackMessage(baseUrl, build) : webhook.format === "discord" ? discordMessage(baseUrl, build) : jsonPayload(baseUrl, build);
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "Drop" };
      const signingKey = env[secretName(name, "_SECRET")];
      if (webhook.format === "json" && typeof signingKey === "string" && signingKey) {
        headers["x-drop-signature-256"] = `sha256=${await hmacSha256Hex(signingKey, body)}`;
      }
      let failure = "";
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await doFetch(url, { method: "POST", headers, body });
          if (response.ok) {
            delivered.push(name);
            return;
          }
          failure = `HTTP ${response.status}`;
          if (response.status !== 429 && response.status < 500) break;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
        }
        if (attempt >= RETRY_DELAYS_MS.length) {
          console.error(`Webhook ${name} failed for Build ${build.id}: ${failure}.`);
          return;
        }
        await sleep(RETRY_DELAYS_MS[attempt]!);
      }
      console.error(`Webhook ${name} refused Build ${build.id}: ${failure}.`);
    }),
  );
  return delivered;
}

async function hmacSha256Hex(key: string, body: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
