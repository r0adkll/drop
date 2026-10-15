import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deploySteps, devSteps, loadDeployment, wranglerEnvironment } from "../../scripts/deployment.ts";
import { deploymentPaths } from "../../scripts/paths.ts";
import { deploymentWranglerConfig, parseJsonc, type WranglerConfig } from "../../scripts/wrangler-config.ts";

const cloudflare = { accountId: "0123456789abcdef0123456789abcdef", workerName: "drop", d1DatabaseId: "11111111-2222-3333-4444-555555555555", r2Bucket: "drop-builds" };
const committed = parseJsonc(readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8")) as WranglerConfig;
const input = (url: string) => ({ url, cloudflare, configPath: "/deployment/drop.config.json", lockPath: "/deployment/drop.config.lock.json" });

describe("parseJsonc", () => {
  it("drops comments and trailing commas but keeps them inside strings", () => {
    expect(
      parseJsonc(`// header
      {
        "url": "https://example.com/a//b", /* block */
        "list": [1, 2,],
        "text": "a /* not a comment */ ,}",
      }`),
    ).toEqual({ url: "https://example.com/a//b", list: [1, 2], text: "a /* not a comment */ ,}" });
  });

  it("reads the committed wrangler.jsonc", () => {
    expect(committed.name).toBe("drop");
    expect(committed.alias).toEqual({ "drop-deployment/config": "../drop.config.json", "drop-deployment/lock": "../drop.config.lock.json" });
  });
});

describe("the generated Wrangler config", () => {
  it("points the Worker at the deployment's resources and files", () => {
    const generated = deploymentWranglerConfig(committed, input("https://drop.example.com"));
    expect(generated.$schema).toBeUndefined();
    expect(generated.name).toBe("drop");
    expect(generated.account_id).toBe(cloudflare.accountId);
    expect(generated.alias).toEqual({ "drop-deployment/config": "/deployment/drop.config.json", "drop-deployment/lock": "/deployment/drop.config.lock.json" });
    expect(generated.d1_databases).toEqual([expect.objectContaining({ binding: "DB", database_name: "drop", database_id: cloudflare.d1DatabaseId, migrations_dir: "migrations" })]);
    expect(generated.r2_buckets).toEqual([{ binding: "BUILDS", bucket_name: "drop-builds" }]);
    expect(generated.vars).toEqual({ R2_BUCKET_NAME: "drop-builds" });
    // Everything else passes through.
    expect(generated.secrets).toEqual(committed.secrets);
    expect(generated.triggers).toEqual(committed.triggers);
    expect(generated.main).toBe("src/index.ts");
  });

  it("serves a custom hostname as a Custom Domain, with the workers.dev URL off", () => {
    const generated = deploymentWranglerConfig(committed, input("https://drop.example.com"));
    expect(generated.routes).toEqual([{ pattern: "drop.example.com", custom_domain: true }]);
    expect(generated.workers_dev).toBe(false);
    expect(generated.preview_urls).toBe(false);
  });

  it("serves a workers.dev URL from the Worker of that name", () => {
    const generated = deploymentWranglerConfig(committed, input("https://drop.your-team.workers.dev"));
    expect(generated.routes).toBeUndefined();
    expect(generated.workers_dev).toBe(true);
    expect(() => deploymentWranglerConfig(committed, input("https://other.your-team.workers.dev"))).toThrow(/named "other"/);
  });

  it("follows the lockfile's names", () => {
    const generated = deploymentWranglerConfig(committed, { ...input("https://drop.example.com"), cloudflare: { ...cloudflare, workerName: "drop-two", r2Bucket: "drop-two-builds" } });
    expect(generated.name).toBe("drop-two");
    expect(generated.r2_buckets?.[0]?.bucket_name).toBe("drop-two-builds");
    expect(generated.vars?.R2_BUCKET_NAME).toBe("drop-two-builds");
  });

  it("fails when wrangler.jsonc lacks a binding the Worker needs", () => {
    expect(() => deploymentWranglerConfig({ ...committed, d1_databases: [] }, input("https://drop.example.com"))).toThrow(/DB/);
    expect(() => deploymentWranglerConfig({ ...committed, r2_buckets: [] }, input("https://drop.example.com"))).toThrow(/BUILDS/);
  });
});

describe("deploying", () => {
  it("applies migrations before deploying", () => {
    expect(deploySteps({ configFile: "/s/wrangler.deployment.json" })).toEqual([
      ["d1", "migrations", "apply", "DB", "--remote", "--config", "/s/wrangler.deployment.json"],
      ["deploy", "--config", "/s/wrangler.deployment.json"],
    ]);
  });

  it("uploads .dev.vars with the first deploy", () => {
    expect(deploySteps({ configFile: "c.json", secretsFile: "/d/.dev.vars" })[1]).toEqual(["deploy", "--config", "c.json", "--secrets-file", "/d/.dev.vars"]);
  });

  it("only builds on a dry run", () => {
    expect(deploySteps({ configFile: "c.json", dryRun: true })).toEqual([["deploy", "--config", "c.json", "--dry-run"]]);
  });

  it("keeps local state with the deployment while developing", () => {
    const steps = devSteps({ configFile: "c.json", devVars: "/nowhere/.dev.vars", localState: "/d/.wrangler/state", args: ["--port", "9000"] });
    expect(steps[0]).toEqual(["d1", "migrations", "apply", "DB", "--local", "--persist-to", "/d/.wrangler/state", "--config", "c.json"]);
    expect(steps[1]).toEqual(["dev", "--config", "c.json", "--persist-to", "/d/.wrangler/state", "--port", "9000"]);
  });

  it("runs wrangler on the lockfile's account, refusing a different one", () => {
    expect(wranglerEnvironment(cloudflare, { PATH: "/bin" })).toEqual({ PATH: "/bin", CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId });
    expect(wranglerEnvironment(cloudflare, { CLOUDFLARE_ACCOUNT_ID: cloudflare.accountId }).CLOUDFLARE_ACCOUNT_ID).toBe(cloudflare.accountId);
    expect(() => wranglerEnvironment(cloudflare, { CLOUDFLARE_ACCOUNT_ID: "f".repeat(32) })).toThrow(/lock\.json's deployment is on account/);
  });
});

describe("loading a deployment", () => {
  const deployment = (lock: object | undefined) => {
    const dir = mkdtempSync(join(tmpdir(), "drop-deployment-"));
    writeFileSync(join(dir, "drop.config.json"), JSON.stringify({ url: "https://drop.example.com", owners: ["your-org"] }));
    if (lock) writeFileSync(join(dir, "drop.config.lock.json"), JSON.stringify(lock));
    return deploymentPaths({ DROP_DEPLOYMENT_DIR: dir });
  };

  it("reads a complete deployment from DROP_DEPLOYMENT_DIR", () => {
    const paths = deployment({ owners: { "your-org": 1 }, cloudflare });
    expect(paths.devVars).toBe(join(paths.dir, ".dev.vars"));
    expect(loadDeployment(paths).lock.cloudflare).toEqual(cloudflare);
  });

  it("refuses to deploy before setup has recorded the Cloudflare resources", () => {
    expect(() => loadDeployment(deployment({ owners: { "your-org": 1 } }))).toThrow(/no cloudflare\.accountId; run `\.\/drop setup`/);
    expect(() => loadDeployment(deployment(undefined))).toThrow(/lock\.json is missing/);
  });

  it("defaults to this repository's placeholders", () => {
    expect(deploymentPaths({}).config).toBe(new URL("../../../drop.config.json", import.meta.url).pathname);
  });
});
