import { describe, expect, it } from "vitest";
import { deleteBuild, parseDeleteBuildArgs, type BuildToDelete, type DeleteBuildIo } from "../../scripts/delete-build.ts";

const BUILD: BuildToDelete = {
  id: "k7Qm2xPa",
  application_id: "com.example.trailhead",
  label: "Trailhead",
  version_name: "2.8.0",
  version_code: 4127,
  channel: "main",
  uploaded_at: Date.UTC(2026, 9, 15, 14, 2),
  deleted_reason: null,
  file_key: "builds/k7Qm2xPa/1/app.apk",
};

function fakeIo(found: BuildToDelete[], confirmed = true) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const io: DeleteBuildIo = {
    wrangler: (args) => {
      calls.push(args);
      return args.includes("--json") && args.at(-1)!.trimStart().startsWith("SELECT") ? JSON.stringify([{ results: found }]) : "";
    },
    confirm: async () => confirmed,
    log: (message) => logs.push(message),
    now: () => 1_800_000_000_000,
  };
  return { io, calls, logs };
}

const options = { id: "k7Qm2xPa", configFile: "wrangler.generated.json", bucket: "drop-builds", yes: false };

describe("./drop delete-build", () => {
  it("marks the Build removed by the operator and deletes its APK", async () => {
    const { io, calls, logs } = fakeIo([BUILD]);
    expect(await deleteBuild(options, io)).toBe(true);
    expect(logs[0]).toBe("Build k7Qm2xPa: Trailhead 2.8.0 (4127) on main, uploaded 2026-10-15 14:02 UTC.");
    expect(calls).toHaveLength(3);
    expect(calls[1]!.at(-1)).toContain("UPDATE builds SET deleted_at = 1800000000000, deleted_reason = 'operator' WHERE id = 'k7Qm2xPa'");
    expect(calls[1]!.at(-1)).toContain("DELETE FROM uploads WHERE build_id = 'k7Qm2xPa'");
    expect(calls[2]).toEqual(["r2", "object", "delete", "drop-builds/builds/k7Qm2xPa/1/app.apk", "--remote", "--config", "wrangler.generated.json"]);
  });

  it("changes nothing when the operator declines", async () => {
    const { io, calls } = fakeIo([BUILD], false);
    expect(await deleteBuild(options, io)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("deletes the APK again for a Build already removed, without asking", async () => {
    const { io, calls } = fakeIo([{ ...BUILD, deleted_reason: "operator" }], false);
    expect(await deleteBuild(options, io)).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["d1", "r2"]);
  });

  it("fails clearly for an unknown Build and bad arguments", async () => {
    await expect(deleteBuild(options, fakeIo([]).io)).rejects.toThrow("This deployment has no Build k7Qm2xPa.");
    expect(parseDeleteBuildArgs(["k7Qm2xPa", "--yes"])).toEqual({ id: "k7Qm2xPa", yes: true });
    expect(() => parseDeleteBuildArgs(["k7Qm2xPa'; DROP TABLE builds; --"])).toThrow("Usage: ./drop delete-build");
    expect(() => parseDeleteBuildArgs([])).toThrow("Usage");
  });
});
