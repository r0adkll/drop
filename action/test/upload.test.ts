import { describe, expect, it } from "vitest";
import { upload, type CreateUploadRequest } from "../src/upload.ts";

const request: CreateUploadRequest = {
  applicationId: "com.example.trailhead",
  versionCode: 4127,
  signerSha256: "3a".repeat(32),
  apk: { size: 4, sha256: "b".repeat(64) },
  channel: "main",
  defaultBranch: true,
  commit: { sha: "a".repeat(40) },
};

function fakeFetch(responses: Record<string, () => Response>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: unknown }[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    const respond = responses[`${init?.method} ${url}`];
    return respond ? respond() : new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { doFetch, calls };
}

const created = {
  buildId: "k7Qm2xPa",
  buildUrl: "https://drop.example.com/b/k7Qm2xPa",
  expiresAt: "2026-10-15T14:12:00.000Z",
  apk: { url: "https://r2.example.com/apk", method: "PUT", headers: { "x-amz-checksum-sha256": "c2hh" } },
  icon: { url: "https://r2.example.com/icon", method: "PUT", headers: { "x-amz-checksum-sha256": "aWNv" } },
};

describe("upload", () => {
  it("creates, puts both files with their signed headers, then completes", async () => {
    const { doFetch, calls } = fakeFetch({
      "POST https://drop.example.com/api/v1/uploads": () => Response.json(created, { status: 201 }),
      "PUT https://r2.example.com/apk": () => new Response(null, { status: 200 }),
      "PUT https://r2.example.com/icon": () => new Response(null, { status: 200 }),
      "POST https://drop.example.com/api/v1/uploads/k7Qm2xPa/complete": () => Response.json({ buildId: "k7Qm2xPa", buildUrl: created.buildUrl }),
    });
    const apk = new Blob(["apk!"]);

    const build = await upload("https://drop.example.com", "token", request, { apk, icon: new Blob(["ico"]) }, doFetch);

    expect(build.buildUrl).toBe(created.buildUrl);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST https://drop.example.com/api/v1/uploads",
      "PUT https://r2.example.com/apk",
      "PUT https://r2.example.com/icon",
      "POST https://drop.example.com/api/v1/uploads/k7Qm2xPa/complete",
    ]);
    expect(calls[0]!.headers.authorization).toBe("Bearer token");
    expect(JSON.parse(calls[0]!.body as string)).toEqual(request);
    expect(calls[1]!.headers).toEqual({ "x-amz-checksum-sha256": "c2hh" });
    expect(calls[1]!.body).toBe(apk);
    expect(calls[3]!.headers.authorization).toBe("Bearer token");
  });

  it("reports the server's error", async () => {
    const { doFetch } = fakeFetch({
      "POST https://drop.example.com/api/v1/uploads": () =>
        Response.json({ code: "repository_not_allowed", message: "your-org/trailhead is not listed." }, { status: 403 }),
    });
    await expect(upload("https://drop.example.com", "t", request, { apk: new Blob(["x"]) }, doFetch)).rejects.toThrow(
      "Drop refused the upload: your-org/trailhead is not listed. (repository_not_allowed)",
    );
  });

  it("reports a failed PUT", async () => {
    const { doFetch } = fakeFetch({
      "POST https://drop.example.com/api/v1/uploads": () => Response.json(created, { status: 201 }),
      "PUT https://r2.example.com/apk": () => new Response("<Error><Code>BadDigest</Code></Error>", { status: 400 }),
    });
    await expect(upload("https://drop.example.com", "t", request, { apk: new Blob(["x"]) }, doFetch)).rejects.toThrow(/Uploading the APK failed: HTTP 400: .*BadDigest/);
  });
});
