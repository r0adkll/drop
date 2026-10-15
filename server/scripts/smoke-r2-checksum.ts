// Checks whether R2 enforces the SHA-256 that Drop signs into presigned upload URLs
// (docs/implementation-notes.md#cloudflare). Run it against your own bucket:
//
//   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… R2_BUCKET_NAME=drop-builds \
//     node scripts/smoke-r2-checksum.ts
//
// It writes and then deletes one small object under smoke/.

import { createHash, randomBytes } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { hexToBase64, r2Presigner } from "../src/presign.ts";

const names = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"] as const;
const missing = names.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Set ${missing.join(", ")} first.`);
  process.exit(2);
}
const accountId = process.env.R2_ACCOUNT_ID!;
const accessKeyId = process.env.R2_ACCESS_KEY_ID!;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!;
const bucket = process.env.R2_BUCKET_NAME!;

const presigner = r2Presigner({ accountId, accessKeyId, secretAccessKey, bucket });
const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
const key = `smoke/checksum-${Date.now()}`;
const objectUrl = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
const body = randomBytes(1024);
const sha256 = createHash("sha256").update(body).digest("hex");
const wrongSha256 = createHash("sha256").update("something else").digest("hex");

async function put(checksumHex: string): Promise<Response> {
  const signed = await presigner.presignPut(key, checksumHex, 300);
  return fetch(signed.url, { method: signed.method, headers: signed.headers, body });
}

try {
  const wrong = await put(wrongSha256);
  console.log(`PUT with a wrong checksum: HTTP ${wrong.status}`);
  const right = await put(sha256);
  console.log(`PUT with the right checksum: HTTP ${right.status}`);
  if (!right.ok) {
    console.error(await right.text());
    console.error("\nVerdict: inconclusive. A correctly signed upload failed; check the credentials and bucket name.");
    process.exit(1);
  }

  const head = await client.fetch(objectUrl, { method: "HEAD", headers: { "x-amz-checksum-mode": "ENABLED" } });
  const reported = head.headers.get("x-amz-checksum-sha256");
  console.log(`HEAD reports x-amz-checksum-sha256: ${reported ?? "(none)"}`);

  const enforced = !wrong.ok;
  const stored = reported === hexToBase64(sha256);
  if (enforced && stored) {
    console.log("\nVerdict: ENFORCED. R2 rejects a body that doesn't match the signed SHA-256 and stores the checksum.");
  } else if (enforced) {
    console.log("\nVerdict: ENFORCED, NOT REPORTED. R2 rejects mismatches but doesn't report the stored checksum over S3.");
  } else {
    console.log("\nVerdict: NOT ENFORCED. R2 accepted a body that doesn't match the signed SHA-256; the server can check size only.");
  }
} finally {
  await client.fetch(objectUrl, { method: "DELETE" });
}
