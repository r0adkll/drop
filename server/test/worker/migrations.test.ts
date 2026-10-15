import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("migrations", () => {
  it("create the tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('products', 'channels', 'builds') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["builds", "channels", "products"]);
  });

  it("allow one Build per run of a Product", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO products (application_id, repository_id, repository, repository_visibility, created_at) VALUES ('com.example.app', 1, 'your-org/app', 'public', 0)",
      ),
      env.DB.prepare(
        "INSERT INTO channels (id, application_id, name, is_default, created_at) VALUES (1, 'com.example.app', 'main', 1, 0)",
      ),
    ]);
    const insertBuild = (id: string) =>
      env.DB.prepare(
        `INSERT INTO builds (id, application_id, channel_id, run_id, run_attempt, workflow, run_number,
           event_name, ref, commit_sha, built_sha, version_code, signer_sha256, file_size, file_sha256,
           file_key, created_at)
         VALUES (?, 'com.example.app', 1, 42, 1, 'Android', 7, 'push', 'refs/heads/main', 'abc', 'abc', 1,
           'aa', 1, 'bb', 'k', 0)`,
      ).bind(id);

    await insertBuild("k7Qm2xPa").run();
    await expect(insertBuild("Rt4wN8cZ").run()).rejects.toThrow(/UNIQUE/);
    await expect(insertBuild("toolongid").run()).rejects.toThrow(/CHECK/);
  });

  it("allow one default Channel per Product", async () => {
    await env.DB.prepare(
      "INSERT INTO products (application_id, repository_id, repository, repository_visibility, created_at) VALUES ('com.example.other', 1, 'your-org/other', 'public', 0)",
    ).run();
    const insertDefault = (name: string) =>
      env.DB.prepare(
        "INSERT INTO channels (application_id, name, is_default, created_at) VALUES ('com.example.other', ?, 1, 0)",
      ).bind(name);

    await insertDefault("main").run();
    await expect(insertDefault("develop").run()).rejects.toThrow(/UNIQUE/);
  });
});
