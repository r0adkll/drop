import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../../src/config";
import { coversChannel, discordMessage, loadAnnouncedBuild, secretName, sendBuildWebhooks, slackMessage, type AnnouncedBuild } from "../../src/notifications";
import { qrPng } from "../../src/qr";
import { createTestApp, NOW, seedBuild, uniqueApplicationId, uploadRequest } from "./support";

const BASE = "https://drop.example.com";
const build: AnnouncedBuild = {
  id: "Hc2pQ7ve",
  applicationId: "com.example.trailhead",
  name: "Trailhead",
  versionName: "2.9.0",
  versionCode: 4130,
  channel: "main",
  isDefaultChannel: true,
  pullRequest: null,
  repository: "your-org/trailhead",
  commitSha: "9496dd5".padEnd(40, "0"),
  headline: "Offline map tiles for saved trails (#142)",
  workflow: "Android",
  runNumber: 1880,
  runId: 11384730000,
  fileSize: 38_412_345,
  fileSha256: "b".repeat(64),
  uploadedAt: NOW,
  hasIcon: true,
};

/** A fetch that answers with `statuses` in turn (then 200) and records each request. */
function recordingFetch(...statuses: number[]) {
  const requests: { url: string; headers: Headers; body: any }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers, body: JSON.parse(await request.text()) });
    return new Response(null, { status: statuses[requests.length - 1] ?? 200 });
  }) as typeof fetch;
  return { fetch: fetchFn, requests };
}

const noSleep = async () => {};

describe("messages", () => {
  it("covers the default Channel unless patterns are listed", () => {
    expect(coversChannel(undefined, "main", true)).toBe(true);
    expect(coversChannel(undefined, "pr/142", false)).toBe(false);
    expect(coversChannel(["pr/*"], "pr/142", false)).toBe(true);
    expect(coversChannel(["main"], "beta", false)).toBe(false);
    expect(coversChannel(["*"], "beta", false)).toBe(true);
    expect(secretName("team-slack")).toBe("WEBHOOK_TEAM_SLACK");
    expect(secretName("ci", "_SECRET")).toBe("WEBHOOK_CI_SECRET");
  });

  it("builds the Slack message as drawn, escaping what an upload controls", () => {
    const message = slackMessage(BASE, { ...build, headline: "Fix <!channel> & <https://x.example|tricks>" }) as any;
    expect(message.text).toBe("Trailhead 2.9.0 (4130) is on main");
    expect(message.blocks[0].text.text).toBe(
      "*<https://drop.example.com/b/Hc2pQ7ve|Trailhead 2.9.0 (4130)>* is on `main`\n" +
        "Fix &lt;!channel&gt; &amp; &lt;https://x.example|tricks&gt;\n" +
        `<https://github.com/your-org/trailhead/commit/${build.commitSha}|9496dd5> · ` +
        "<https://github.com/your-org/trailhead/actions/runs/11384730000|Android #1880> · 38.4 MB",
    );
    expect(message.blocks[0].accessory).toEqual({ type: "image", image_url: "https://drop.example.com/b/Hc2pQ7ve/icon", alt_text: "Trailhead" });
    expect(message.blocks[1].elements[0]).toMatchObject({ url: "https://drop.example.com/b/Hc2pQ7ve", style: "primary" });
    expect(message.blocks[2]).toMatchObject({ type: "image", image_url: "https://drop.example.com/b/Hc2pQ7ve/qr.png" });
    expect((slackMessage(BASE, { ...build, hasIcon: false }) as any).blocks[0].accessory).toBeUndefined();
  });

  it("builds the Discord embed as drawn, without mentions", () => {
    const message = discordMessage(BASE, { ...build, headline: "@everyone *look*" }) as any;
    expect(message.allowed_mentions).toEqual({ parse: [] });
    const embed = message.embeds[0];
    expect(embed).toMatchObject({
      title: "Trailhead 2.9.0 (4130) on main",
      url: "https://drop.example.com/b/Hc2pQ7ve",
      description: "@everyone \\*look\\*",
      thumbnail: { url: "https://drop.example.com/b/Hc2pQ7ve/icon" },
      image: { url: "https://drop.example.com/b/Hc2pQ7ve/qr.png" },
      footer: { text: "Scan to install · your-org/trailhead" },
    });
    expect(embed.fields.map((f: { name: string }) => f.name)).toEqual(["Commit", "CI run", "Size"]);
  });
});

describe("sendBuildWebhooks", () => {
  const environment = (extra: Record<string, string> = {}) => ({ DB: env.DB, WEBHOOK_TEAM: "https://hooks.example.com/team", ...extra });

  it("sends a default-Channel Build to the webhooks that cover it", async () => {
    const seeded = await seedBuild({ channel: "main", commitMessage: "Cache map tiles\n\nBody" });
    const pr = await seedBuild({ applicationId: seeded.applicationId, channel: "pr/9", runId: 2 });
    const recorder = recordingFetch();
    const webhooks = { team: { format: "slack" as const }, other: { format: "discord" as const, products: ["com.example.elsewhere"] } };
    expect(await sendBuildWebhooks(environment(), BASE, seeded.id, { fetch: recorder.fetch, sleep: noSleep, webhooks })).toEqual(["team"]);
    expect(recorder.requests).toHaveLength(1);
    expect(recorder.requests[0]!.url).toBe("https://hooks.example.com/team");
    expect(recorder.requests[0]!.body.blocks[0].text.text).toContain("Cache map tiles");
    // A pull request Build needs a pattern that covers it.
    expect(await sendBuildWebhooks(environment(), BASE, pr.id, { fetch: recorder.fetch, sleep: noSleep, webhooks })).toEqual([]);
    expect(await sendBuildWebhooks(environment(), BASE, pr.id, { fetch: recorder.fetch, sleep: noSleep, webhooks: { team: { format: "slack", channels: ["pr/*"] } } })).toEqual(["team"]);
  });

  it("retries a failing delivery twice, and doesn't retry a refusal", async () => {
    const seeded = await seedBuild({ channel: "main" });
    const flaky = recordingFetch(503, 500);
    expect(await sendBuildWebhooks(environment(), BASE, seeded.id, { fetch: flaky.fetch, sleep: noSleep, webhooks: { team: { format: "slack" } } })).toEqual(["team"]);
    expect(flaky.requests).toHaveLength(3);
    const refused = recordingFetch(400);
    expect(await sendBuildWebhooks(environment(), BASE, seeded.id, { fetch: refused.fetch, sleep: noSleep, webhooks: { team: { format: "slack" } } })).toEqual([]);
    expect(refused.requests).toHaveLength(1);
  });

  it("signs JSON with the webhook's secret", async () => {
    const seeded = await seedBuild({ channel: "main" });
    const recorder = recordingFetch();
    await sendBuildWebhooks(environment({ WEBHOOK_TEAM_SECRET: "s3cret" }), BASE, seeded.id, { fetch: recorder.fetch, sleep: noSleep, webhooks: { team: { format: "json" } } });
    const { headers, body } = recorder.requests[0]!;
    expect(body).toMatchObject({ event: "build.uploaded", build: { buildId: seeded.id, qrUrl: `${BASE}/b/${seeded.id}/qr.png` } });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify(body)));
    expect(headers.get("x-drop-signature-256")).toBe(`sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
  });

  it("announces nothing for a Private product or a webhook without its secret", async () => {
    const seeded = await seedBuild({ channel: "main" });
    await env.DB.prepare("UPDATE products SET repository_visibility = 'private' WHERE application_id = ?").bind(seeded.applicationId).run();
    const recorder = recordingFetch();
    expect(await sendBuildWebhooks(environment(), BASE, seeded.id, { fetch: recorder.fetch, sleep: noSleep, webhooks: { team: { format: "slack" } } })).toEqual([]);
    const open = await seedBuild({ channel: "main" });
    expect(await sendBuildWebhooks({ DB: env.DB }, BASE, open.id, { fetch: recorder.fetch, sleep: noSleep, webhooks: { team: { format: "slack" } } })).toEqual([]);
    expect(recorder.requests).toHaveLength(0);
    expect((await loadAnnouncedBuild(env.DB, open.id))?.build.headline).toBe("Trailhead");
  });
});

describe("webhooks from uploads", () => {
  afterEach(() => {
    delete config.webhooks;
  });

  it("posts a Build's first confirmation once, and nothing for a later attempt of its run", async () => {
    config.webhooks = { "test-slack": { format: "slack" } };
    const recorder = recordingFetch();
    const t = await createTestApp({ webhookFetch: recorder.fetch });
    const applicationId = uniqueApplicationId();
    const attempt = async (runAttempt: string) => {
      const token = await t.issuer.sign({ run_id: "11384799000", run_attempt: runAttempt });
      const post = (path: string, body?: unknown) =>
        t.app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
      const { buildId } = (await (await post("/api/v1/uploads", uploadRequest(applicationId))).json()) as { buildId: string };
      await env.BUILDS.put(`builds/${buildId}/${runAttempt}/app.apk`, new Uint8Array([1, 2, 3, 4]));
      expect((await post(`/api/v1/uploads/${buildId}/complete`)).status).toBe(200);
      return buildId;
    };
    const buildId = await attempt("1");
    await vi.waitFor(() => expect(recorder.requests).toHaveLength(1));
    expect(recorder.requests[0]!.url).toBe("https://hooks.example.com/test-slack");
    expect(await attempt("2")).toBe(buildId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recorder.requests).toHaveLength(1);
  });

  it("posts nothing for a Wear Build", async () => {
    config.webhooks = { "test-slack": { format: "slack" } };
    const recorder = recordingFetch();
    const t = await createTestApp({ webhookFetch: recorder.fetch });
    const token = await t.issuer.sign({ run_id: "11384799100" });
    const post = (path: string, body?: unknown) =>
      t.app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    const { buildId } = (await (await post("/api/v1/uploads", uploadRequest(uniqueApplicationId(), { formFactor: "wear" }))).json()) as { buildId: string };
    await env.BUILDS.put(`builds/${buildId}/1/app.apk`, new Uint8Array([1, 2, 3, 4]));
    expect((await post(`/api/v1/uploads/${buildId}/complete`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recorder.requests).toHaveLength(0);
  });
});

describe("the PNG QR code", () => {
  it("is a grayscale PNG that the route serves", async () => {
    const png = await qrPng("https://drop.example.com/b/Hc2pQ7ve");
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(view.getUint32(20));
    expect(view.getUint32(16) % 8).toBe(0);

    const seeded = await seedBuild({ channel: "main" });
    const { app } = await createTestApp();
    const response = await app.request(`/b/${seeded.id}/qr.png`, {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect((await app.request("/b/NOSUCH00/qr.png", {}, env)).status).toBe(404);
  });
});
