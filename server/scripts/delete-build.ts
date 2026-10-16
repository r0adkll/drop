// `./drop delete-build <id>`: removes one Build from a deployment in an emergency, such as a Build
// that leaked a secret (docs/design.md#deleting-a-build). It marks the Build removed in D1, so its
// page says the operator removed it and no Update check offers it, then deletes its APK from R2
// straight away rather than at the next hourly sweep. The icon is kept, as retention keeps it.

const BUILD_ID = /^[0-9A-Za-z]{8}$/;

export interface BuildToDelete {
  id: string;
  application_id: string;
  label: string | null;
  version_name: string | null;
  version_code: number;
  channel: string;
  uploaded_at: number;
  deleted_reason: string | null;
  file_key: string;
}

export interface DeleteBuildIo {
  /** Runs wrangler with these arguments and returns its stdout, throwing if it fails. */
  wrangler(args: string[]): string;
  confirm(question: string): Promise<boolean>;
  log(message: string): void;
  now(): number;
}

export interface DeleteBuildOptions {
  id: string;
  configFile: string;
  bucket: string;
  /** Skips the confirmation, for scripts. */
  yes: boolean;
}

export function parseDeleteBuildArgs(args: string[]): { id: string; yes: boolean } {
  const yes = args.includes("--yes");
  const rest = args.filter((arg) => arg !== "--yes");
  if (rest.length !== 1 || !BUILD_ID.test(rest[0]!)) {
    throw new Error("Usage: ./drop delete-build <build-id> [--yes], with the 8-character ID from the Build page's URL (/b/<id>).");
  }
  return { id: rest[0]!, yes };
}

/** Removes the Build; returns false when the operator declines. */
export async function deleteBuild(options: DeleteBuildOptions, io: DeleteBuildIo): Promise<boolean> {
  const { id, configFile, bucket } = options;
  // The ID is checked against BUILD_ID, so it is safe inside the SQL.
  if (!BUILD_ID.test(id)) throw new Error(`"${id}" is not a Build ID.`);
  const d1 = (sql: string) => io.wrangler(["d1", "execute", "DB", "--remote", "--json", "--config", configFile, "--command", sql]);

  const rows = (JSON.parse(d1(
    `SELECT b.id, b.application_id, b.label, b.version_name, b.version_code, c.name AS channel, b.uploaded_at,
       b.deleted_reason, b.file_key
     FROM builds b JOIN channels c ON c.id = b.channel_id WHERE b.id = '${id}'`,
  )) as { results: BuildToDelete[] }[])[0]?.results ?? [];
  const build = rows[0];
  if (!build) throw new Error(`This deployment has no Build ${id}.`);

  const name = build.label ?? build.application_id;
  const version = build.version_name ? `${build.version_name} (${build.version_code})` : `(${build.version_code})`;
  const uploaded = new Date(build.uploaded_at).toISOString().slice(0, 16).replace("T", " ");
  io.log(`Build ${id}: ${name} ${version} on ${build.channel}, uploaded ${uploaded} UTC.`);
  if (build.deleted_reason === "operator") io.log("It was already removed; deleting its APK again in case that step failed.");
  else if (!options.yes && !(await io.confirm("Remove it? Its APK is deleted now and its Build page will say it was removed."))) return false;

  if (build.deleted_reason !== "operator") {
    d1(
      `UPDATE builds SET deleted_at = ${io.now()}, deleted_reason = 'operator' WHERE id = '${id}';
       DELETE FROM uploads WHERE build_id = '${id}';`,
    );
  }
  io.wrangler(["r2", "object", "delete", `${bucket}/${build.file_key}`, "--remote", "--config", configFile]);
  io.log(
    `Removed ${id}. Update checks no longer offer it and a re-run of its workflow can't upload it again. ` +
      "Download caches may serve the APK for up to five more minutes.",
  );
  return true;
}
