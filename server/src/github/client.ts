// The deployment's GitHub App talking to GitHub's REST API (ADR 0010): as the App itself with a
// short-lived JWT, or as one of its installations with an installation access token.

import { SignJWT } from "jose";

const API = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** GitHub accepts App JWTs that live at most 10 minutes. */
const JWT_LIFETIME_SECONDS = 9 * 60;
/** Reuse a cached JWT or installation token only while it has at least this long left. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PER_PAGE = 100;

export const NO_APP = "drop.config.lock.json has no GitHub App; run `./drop setup` in the deployment repository to create it.";

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubRequest {
  method?: string;
  body?: unknown;
  /** Act as this installation. Without it, the request is made as the App (its JWT). */
  installation?: number;
}

export interface GitHubApp {
  readonly appId: number;
  request<T>(path: string, options?: GitHubRequest): Promise<T>;
  /** Every page of a list endpoint. `key` names the array in endpoints that wrap it in an object. */
  list<T>(path: string, options?: Omit<GitHubRequest, "method" | "body"> & { key?: string }): Promise<T[]>;
}

export interface GitHubAppOptions {
  /** From drop.config.lock.json's `app.id`. */
  appId: number | undefined;
  /** The private key as GitHub issues it (PKCS#1, `BEGIN RSA PRIVATE KEY`), or PKCS#8. */
  privateKey: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createGitHubApp(options: GitHubAppOptions): GitHubApp {
  const appId = Number(options.appId);
  if (!Number.isInteger(appId) || appId <= 0) throw new Error(NO_APP);
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const key = importPrivateKey(options.privateKey);
  let jwt: { value: string; expiresAt: number } | undefined;
  const tokens = new Map<number, { value: string; expiresAt: number }>();

  async function appJwt(): Promise<string> {
    const at = now();
    if (jwt && jwt.expiresAt - at > REFRESH_MARGIN_MS) return jwt.value;
    // Backdated a minute against clock drift, as GitHub recommends.
    const iat = Math.floor(at / 1000) - 60;
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(String(appId))
      .setIssuedAt(iat)
      .setExpirationTime(iat + JWT_LIFETIME_SECONDS)
      .sign(await key);
    jwt = { value, expiresAt: (iat + JWT_LIFETIME_SECONDS) * 1000 };
    return value;
  }

  async function installationToken(installation: number): Promise<string> {
    const cached = tokens.get(installation);
    if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.value;
    const { token, expires_at } = await call<{ token: string; expires_at: string }>(`/app/installations/${installation}/access_tokens`, { method: "POST" });
    tokens.set(installation, { value: token, expiresAt: Date.parse(expires_at) });
    return token;
  }

  async function call<T>(path: string, { method = "GET", body, installation }: GitHubRequest = {}): Promise<T> {
    const authorization = installation === undefined ? `Bearer ${await appJwt()}` : `token ${await installationToken(installation)}`;
    const response = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization,
        "user-agent": `drop-app-${appId}`,
        "x-github-api-version": API_VERSION,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.json<{ message?: string }>().catch(() => undefined);
      throw new GitHubError(response.status, `GitHub ${method} ${path} answered ${response.status}${detail?.message ? `: ${detail.message}` : ""}`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  return {
    appId,
    request: call,
    async list<T>(path: string, { key, ...options }: Omit<GitHubRequest, "method" | "body"> & { key?: string } = {}) {
      const items: T[] = [];
      for (let page = 1; page <= 100; page++) {
        const separator = path.includes("?") ? "&" : "?";
        const response = await call<unknown>(`${path}${separator}per_page=${PER_PAGE}&page=${page}`, options);
        const batch = (key ? (response as Record<string, unknown>)[key] : response) as T[];
        items.push(...batch);
        if (batch.length < PER_PAGE) break;
      }
      return items;
    },
  };
}

// Imported keys outlive requests: one RSA import per isolate, not per request.
const importedKeys = new Map<string, Promise<CryptoKey>>();

function importPrivateKey(pem: string): Promise<CryptoKey> {
  let key = importedKeys.get(pem);
  if (!key) {
    key = crypto.subtle.importKey("pkcs8", toPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    importedKeys.set(pem, key);
  }
  return key;
}

/** PKCS#8 DER from a PEM private key, wrapping GitHub's PKCS#1 keys, which WebCrypto can't import. */
export function toPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  // Secrets pasted on one line may carry literal "\n".
  const text = pem.replace(/\\n/g, "\n");
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(text);
  if (!match) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key.");
  const der = Uint8Array.from(atob(match[2]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return match[1] ? pkcs1ToPkcs8(der) : der;
}

// rsaEncryption (1.2.840.113549.1.1.1) with NULL parameters.
const RSA_ALGORITHM = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];

/** PrivateKeyInfo { version 0, rsaEncryption, OCTET STRING { RSAPrivateKey } }. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  return derElement(0x30, [0x02, 0x01, 0x00, ...RSA_ALGORITHM, ...derElement(0x04, [...pkcs1])]);
}

function derElement(tag: number, content: number[]): Uint8Array<ArrayBuffer> {
  const length: number[] = [];
  if (content.length < 0x80) {
    length.push(content.length);
  } else {
    for (let n = content.length; n > 0; n >>= 8) length.unshift(n & 0xff);
    length.unshift(0x80 | length.length);
  }
  return Uint8Array.from([tag, ...length, ...content]);
}
