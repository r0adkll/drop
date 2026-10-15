import { config } from "./config";
import { ApiError } from "./errors";
import { isPublicProduct } from "./build-page/model";

const APK = "application/vnd.android.package-archive";

/** A single byte range resolved against the file's size. */
export type ByteRange = { offset: number; length: number };

/**
 * Parses a `Range` header against a file of `size` bytes. Returns undefined when the header should be
 * ignored (absent, malformed or several ranges, which RFC 9110 lets a server ignore), "unsatisfiable"
 * when it asks for nothing inside the file, and the range otherwise.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (match[2] !== "" && Number(match[2]) < start) return undefined;
  if (start >= size) return "unsatisfiable";
  return { offset: start, length: end - start + 1 };
}

/** `<name>-<versionName>-<versionCode>.apk`, as an ASCII fallback plus the UTF-8 original. */
export function contentDisposition(name: string, versionName: string | null, versionCode: number): string {
  const full = [name, versionName, String(versionCode)].filter((part) => part).join("-") + ".apk";
  const ascii =
    full
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|-+(?=\.apk$)/g, "") || `app-${versionCode}.apk`;
  const encoded = encodeURIComponent(full).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Streams a Build's APK, with ranges so interrupted downloads resume. Only available, public Builds
 * are served: an expired Build has no file, and Private products wait for milestone 2.
 */
export async function serveDownload(env: Env, buildId: string, request: Request): Promise<Response> {
  const build = /^[0-9A-Za-z]{8}$/.test(buildId)
    ? await env.DB
        .prepare(
          `SELECT b.application_id, b.label, b.version_name, b.version_code, b.file_key, b.deleted_at, p.repository_visibility
           FROM builds b JOIN products p ON p.application_id = b.application_id WHERE b.id = ?`,
        )
        .bind(buildId)
        .first<{
          application_id: string; label: string | null; version_name: string | null; version_code: number;
          file_key: string; deleted_at: number | null; repository_visibility: string;
        }>()
    : null;
  if (!build || build.deleted_at !== null || !isPublicProduct(build.application_id, build.repository_visibility)) {
    throw new ApiError(404, "build_not_found", `There is no Build ${buildId} to download.`);
  }
  const head = await env.BUILDS.head(build.file_key);
  if (!head) throw new ApiError(404, "build_not_found", `Build ${buildId}'s file is missing.`);

  const name = config.products?.[build.application_id]?.displayName ?? build.label ?? build.application_id;
  const headers = new Headers({
    "content-type": APK,
    "content-disposition": contentDisposition(name, build.version_name, build.version_code),
    "accept-ranges": "bytes",
    etag: head.httpEtag,
    // A later attempt of the run can replace the file under the same ID, so caches revalidate.
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });

  if (request.headers.get("if-none-match") === head.httpEtag) return new Response(null, { status: 304, headers });

  // A resumed download only gets the rest of the file if the file hasn't changed since it started.
  const ifRange = request.headers.get("if-range");
  const range = ifRange && ifRange !== head.httpEtag ? undefined : parseRange(request.headers.get("range") ?? undefined, head.size);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }

  if (request.method === "HEAD") {
    headers.set("content-length", String(range ? range.length : head.size));
    if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const object = await env.BUILDS.get(build.file_key, range ? { range } : undefined);
  if (!object) throw new ApiError(404, "build_not_found", `Build ${buildId}'s file is missing.`);
  if (range) {
    headers.set("content-length", String(range.length));
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(head.size));
  return new Response(object.body, { status: 200, headers });
}
