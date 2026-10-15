import { createGitHubApp, type GitHubApp } from "../../src/github/client";
import type { WebhookInstallation, WebhookRepository } from "../../src/github-webhook";

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: string };
  performed_via_github_app: { id: number } | null;
}

export interface GitHubCall {
  method: string;
  path: string;
  search: string;
  authorization: string;
  headers: Headers;
  body: unknown;
}

type Handler = (call: GitHubCall, match: RegExpExecArray) => Response | Promise<Response>;

/**
 * A GitHub that answers the App's API calls from in-memory state, with a real key pair so App JWTs
 * can be verified. Unknown routes answer 404.
 */
export async function createFakeGitHub({ appId = 4242, now = () => Date.now() }: { appId?: number; now?: () => number } = {}) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const privateKeyPem = pem("RSA PRIVATE KEY", pkcs8ToPkcs1(pkcs8));

  const state = {
    installations: [] as WebhookInstallation[],
    repositories: new Map<number, WebhookRepository[]>(),
    /** Issue comments by `owner/repo#number`. */
    comments: new Map<string, FakeComment[]>(),
    tokensIssued: 0,
  };
  const calls: GitHubCall[] = [];
  let nextCommentId = 9_000_000;

  const page = <T>(items: T[], search: URLSearchParams) => {
    const perPage = Number(search.get("per_page") ?? 30);
    const n = Number(search.get("page") ?? 1);
    return items.slice((n - 1) * perPage, n * perPage);
  };
  const installationOf = (call: GitHubCall) => Number(/^token tok-(\d+)-/.exec(call.authorization)?.[1]);
  const issueKey = (match: RegExpExecArray) => `${match[1]}#${match[2]}`;

  const routes: Array<[string, RegExp, Handler]> = [
    ["POST", /^\/app\/installations\/(\d+)\/access_tokens$/, (_call, match) => {
      state.tokensIssued += 1;
      return Response.json({ token: `tok-${match[1]}-${state.tokensIssued}`, expires_at: new Date(now() + 60 * 60 * 1000).toISOString() }, { status: 201 });
    }],
    ["GET", /^\/app\/installations$/, (call) => Response.json(page(state.installations, new URLSearchParams(call.search)))],
    ["GET", /^\/installation\/repositories$/, (call) => {
      const repositories = state.repositories.get(installationOf(call)) ?? [];
      return Response.json({ total_count: repositories.length, repositories: page(repositories, new URLSearchParams(call.search)) });
    }],
    ["GET", /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/, (call, match) =>
      Response.json(page(state.comments.get(issueKey(match)) ?? [], new URLSearchParams(call.search)))],
    ["POST", /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/, (call, match) => {
      const comment: FakeComment = {
        id: (nextCommentId += 1),
        body: (call.body as { body: string }).body,
        user: { login: "drop-example[bot]", type: "Bot" },
        performed_via_github_app: { id: appId },
      };
      state.comments.set(issueKey(match), [...(state.comments.get(issueKey(match)) ?? []), comment]);
      return Response.json(comment, { status: 201 });
    }],
    ["PATCH", /^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/, (call, match) => {
      for (const comments of state.comments.values()) {
        const comment = comments.find((c) => c.id === Number(match[2]));
        if (comment) {
          comment.body = (call.body as { body: string }).body;
          return Response.json(comment);
        }
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    }],
  ];
  const overrides: Array<[string, RegExp, Handler]> = [];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const text = request.body ? await request.text() : "";
    const call: GitHubCall = {
      method: request.method,
      path: url.pathname,
      search: url.search,
      authorization: request.headers.get("authorization") ?? "",
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    for (const [method, pattern, handler] of [...overrides, ...routes]) {
      const match = method === call.method ? pattern.exec(call.path) : null;
      if (match) return handler(call, match);
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;

  return {
    appId,
    publicKey: pair.publicKey,
    pkcs8,
    privateKeyPem,
    state,
    calls,
    fetch: fetchFn,
    /** Answers a route differently, ahead of the defaults. */
    route(method: string, pattern: RegExp, handler: Handler) {
      overrides.unshift([method, pattern, handler]);
    },
    callsTo: (method: string, pattern: RegExp) => calls.filter((call) => call.method === method && pattern.test(call.path)),
    app(): GitHubApp {
      return createGitHubApp({ appId, privateKey: privateKeyPem, fetch: fetchFn, now });
    },
  };
}

export type FakeGitHub = Awaited<ReturnType<typeof createFakeGitHub>>;

function pem(label: string, der: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

/** The RSAPrivateKey inside a PKCS#8 PrivateKeyInfo, as GitHub would issue it. */
export function pkcs8ToPkcs1(pkcs8: Uint8Array): Uint8Array {
  let offset = 0;
  const header = () => {
    const tag = pkcs8[offset++]!;
    let length = pkcs8[offset++]!;
    if (length & 0x80) {
      const bytes = length & 0x7f;
      length = 0;
      for (let i = 0; i < bytes; i++) length = (length << 8) | pkcs8[offset++]!;
    }
    return { tag, length };
  };
  const skip = () => {
    const { length } = header();
    offset += length;
  };
  header(); // PrivateKeyInfo SEQUENCE
  skip(); // version INTEGER
  skip(); // AlgorithmIdentifier SEQUENCE
  const key = header(); // privateKey OCTET STRING
  return pkcs8.slice(offset, offset + key.length);
}
