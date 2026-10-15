import type { components } from "../../server/src/generated/openapi.ts";

export type CreateUploadRequest = components["schemas"]["CreateUploadRequest"];
export type CreateUploadResponse = components["schemas"]["CreateUploadResponse"];
export type PresignedUpload = components["schemas"]["PresignedUpload"];
export type UploadedBuild = components["schemas"]["UploadedBuild"];
type ErrorBody = components["schemas"]["Error"];

export interface UploadFiles {
  apk: Blob;
  icon?: Blob;
}

export class DropError extends Error {}

/** Creates the upload, `PUT`s the files to their presigned URLs, then completes it. */
export async function upload(
  server: string,
  token: string,
  request: CreateUploadRequest,
  files: UploadFiles,
  doFetch: typeof fetch = fetch,
): Promise<UploadedBuild> {
  const auth = { authorization: `Bearer ${token}` };
  const created = await call<CreateUploadResponse>(doFetch, `${server}/api/v1/uploads`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  await put(doFetch, created.apk, files.apk, "APK");
  if (created.icon && files.icon) await put(doFetch, created.icon, files.icon, "icon");

  return call<UploadedBuild>(doFetch, `${server}/api/v1/uploads/${created.buildId}/complete`, { method: "POST", headers: auth });
}

async function call<T>(doFetch: typeof fetch, url: string, init: RequestInit): Promise<T> {
  const response = await doFetch(url, init);
  if (response.ok) return (await response.json()) as T;
  const text = await response.text();
  let detail = `HTTP ${response.status}`;
  try {
    const error = JSON.parse(text) as ErrorBody;
    detail = `${error.message} (${error.code})`;
  } catch {
    if (text) detail += `: ${text.slice(0, 300)}`;
  }
  throw new DropError(`Drop refused the upload: ${detail}`);
}

async function put(doFetch: typeof fetch, target: PresignedUpload, body: Blob, what: string): Promise<void> {
  const response = await doFetch(target.url, { method: target.method, headers: target.headers, body });
  if (!response.ok) {
    const text = await response.text();
    throw new DropError(`Uploading the ${what} failed: HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
  }
}
