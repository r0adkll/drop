import { AwsClient } from "aws4fetch";

export interface PresignedPut {
  url: string;
  method: "PUT";
  /** Signed headers the `PUT` must send exactly. */
  headers: Record<string, string>;
}

export interface Presigner {
  /**
   * A URL that `PUT`s one object key. The SHA-256 is signed in as `x-amz-checksum-sha256`, so storage
   * that checks it rejects any other body (docs/implementation-notes.md#cloudflare).
   */
  presignPut(key: string, sha256Hex: string, expiresInSeconds: number): Promise<PresignedPut>;
}

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2Presigner({ accountId, accessKeyId, secretAccessKey, bucket }: R2Credentials): Presigner {
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  return {
    async presignPut(key, sha256Hex, expiresInSeconds) {
      const url = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
      url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
      const headers = { "x-amz-checksum-sha256": hexToBase64(sha256Hex) };
      const signed = await client.sign(url.toString(), { method: "PUT", headers, aws: { signQuery: true } });
      return { url: signed.url, method: "PUT", headers };
    },
  };
}

export function hexToBase64(hex: string): string {
  let binary = "";
  for (let i = 0; i < hex.length; i += 2) binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(binary);
}

export function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
