import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configErrors } from "../../scripts/validate-config.ts";

// The deployment repository's ./drop script and deployment/init.sh, run for real in temporary
// directories. Nothing here touches the network: "upstream" Drop is a local git repository.

const DEPLOYMENT = new URL("../../../deployment/", import.meta.url).pathname;
const TEMPLATE = join(DEPLOYMENT, "template");

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_NOSYSTEM: "1", HOME: tmpdir() };

function run(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8", env: { ...process.env, ...gitEnv, ...options.env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A deployment repository holding the template, with its workflow's pin line replaced. */
function deploymentWith(usesLine: string | undefined): string {
  const dir = temp("drop-deployment-");
  cpSync(TEMPLATE, dir, { recursive: true });
  const workflow = join(dir, ".github/workflows/deploy.yml");
  if (usesLine === undefined) {
    writeFileSync(workflow, "name: Deploy\n");
  } else {
    writeFileSync(workflow, readFileSync(workflow, "utf8").replace("      - uses: r0adkll/drop/deploy@main", usesLine));
  }
  return dir;
}

describe("./drop", () => {
  it("reads the pinned repository and ref from the deploy workflow", () => {
    for (const [line, expected] of [
      ["      - uses: r0adkll/drop/deploy@main", "r0adkll/drop main"],
      ["      - uses: you/drop-fork/deploy@v1.4.0 # pinned", "you/drop-fork v1.4.0"],
      ['      - uses: "r0adkll/drop/deploy@0123456789abcdef0123456789abcdef01234567"', "r0adkll/drop 0123456789abcdef0123456789abcdef01234567"],
      ["      - uses: r0adkll/drop/deploy@release/1.x", "r0adkll/drop release/1.x"],
    ] as const) {
      const result = run(join(deploymentWith(line), "drop"), ["version"]);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe(expected);
    }
  });

  it("caches each repository and ref separately", () => {
    const dir = deploymentWith("      - uses: r0adkll/drop/deploy@release/1.x");
    expect(run(join(dir, "drop"), ["cache-dir"], { env: { XDG_CACHE_HOME: "/cache" } }).stdout.trim()).toBe("/cache/drop/r0adkll/drop/release_1.x");
  });

  it("fails clearly without a workflow or a pin, and on unknown commands", () => {
    const unpinned = run(join(deploymentWith(undefined), "drop"), ["version"]);
    expect(unpinned.status).toBe(1);
    expect(unpinned.stderr).toContain("has no 'uses: <owner>/<repo>/deploy@<ref>' step");

    const dir = deploymentWith("      - uses: r0adkll/drop/deploy@main");
    const unknown = run(join(dir, "drop"), ["launch"]);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("Usage: ./drop <command>");
    expect(run(join(dir, "drop"), ["help"]).stdout).toContain("setup [options]");
  });

  it("runs setup from a checkout of the pinned ref, installing dependencies once", () => {
    // Upstream Drop: just enough of server/ for the script to install and run.
    const upstream = temp("drop-upstream-");
    mkdirSync(join(upstream, "server/scripts"), { recursive: true });
    writeFileSync(join(upstream, "server/.nvmrc"), "20\n");
    writeFileSync(join(upstream, "server/package-lock.json"), "{}\n");
    writeFileSync(join(upstream, "server/scripts/setup.ts"), 'console.log(`setup ${process.argv.slice(2).join(" ")} in ${process.env.DROP_DEPLOYMENT_DIR}`);\n');
    for (const args of [["init", "-q"], ["add", "."], ["commit", "-q", "-m", "Drop"], ["tag", "v9.9.9"]]) expect(run("git", args, { cwd: upstream }).status).toBe(0);

    // npm is a stub that records each install.
    const bin = temp("drop-bin-");
    const npmLog = join(bin, "npm.log");
    writeFileSync(join(bin, "npm"), `#!/bin/sh\necho "$@" >> "${npmLog}"\nmkdir -p node_modules\n`);
    chmodSync(join(bin, "npm"), 0o755);

    const dir = deploymentWith("      - uses: example/drop/deploy@v9.9.9");
    const env = { DROP_GIT_URL: upstream, XDG_CACHE_HOME: temp("drop-cache-"), PATH: `${bin}:${process.env.PATH}` };
    const first = run(join(dir, "drop"), ["setup", "--skip-app"], { env });
    expect(first.stderr).toBe("");
    expect(first.stdout.trim()).toBe(`setup --skip-app in ${dir}`);
    expect(run(join(dir, "drop"), ["setup"], { env }).status).toBe(0);
    expect(readFileSync(npmLog, "utf8").trim().split("\n")).toEqual(["ci --no-audit --no-fund --loglevel=error"]);
  });
});

describe("deployment/init.sh", () => {
  it("copies the starter files and pins them to the chosen release", () => {
    const target = join(temp("drop-init-"), "my-drop");
    const result = run("sh", [join(DEPLOYMENT, "init.sh"), target, "--ref", "v1.2.3"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pinned to r0adkll/drop/deploy@v1.2.3");
    expect(readFileSync(join(target, ".github/workflows/deploy.yml"), "utf8")).toContain("- uses: r0adkll/drop/deploy@v1.2.3");
    expect(JSON.parse(readFileSync(join(target, "drop.config.json"), "utf8")).$schema).toBe("https://raw.githubusercontent.com/r0adkll/drop/v1.2.3/drop.config.schema.json");
    expect(statSync(join(target, "drop")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
    expect(existsSync(join(target, ".git"))).toBe(true);
    expect(run(join(target, "drop"), ["version"]).stdout.trim()).toBe("r0adkll/drop v1.2.3");
  });

  it("creates the GitHub repository with gh when asked", () => {
    const bin = temp("drop-bin-");
    const ghLog = join(bin, "gh.log");
    writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${ghLog}"\n`);
    chmodSync(join(bin, "gh"), 0o755);
    const target = join(temp("drop-init-"), "my-drop");
    const result = run("sh", [join(DEPLOYMENT, "init.sh"), target, "--github", "you/drop-deployment"], { env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(result.status).toBe(0);
    expect(readFileSync(ghLog, "utf8").trim()).toBe(`repo create you/drop-deployment --private --source ${target} --remote origin`);
  });

  it("refuses a non-empty directory and bad arguments", () => {
    const occupied = temp("drop-init-");
    writeFileSync(join(occupied, "keep.txt"), "");
    expect(run("sh", [join(DEPLOYMENT, "init.sh"), occupied]).stderr).toContain("isn't empty");
    expect(run("sh", [join(DEPLOYMENT, "init.sh")]).status).toBe(2);
    expect(run("sh", [join(DEPLOYMENT, "init.sh"), "x", "--github", "not a repo"]).status).toBe(2);
  });
});

describe("the starter files", () => {
  it("hold a config that matches the schema", () => {
    expect(configErrors(JSON.parse(readFileSync(join(TEMPLATE, "drop.config.json"), "utf8")))).toEqual([]);
  });

  it("keep secrets out of the repository", () => {
    expect(readFileSync(join(TEMPLATE, ".gitignore"), "utf8")).toMatch(/^\.dev\.vars\*$/m);
  });
});

describe("the deploy Action", () => {
  const action = readFileSync(new URL("../../../deploy/action.yml", import.meta.url), "utf8");

  it("takes the inputs the starter workflow passes", () => {
    const workflow = readFileSync(join(TEMPLATE, ".github/workflows/deploy.yml"), "utf8");
    for (const input of workflow.matchAll(/^\s+([a-z-]+): \$\{\{/gm)) expect(action).toMatch(new RegExp(`^  ${input[1]}:$`, "m"));
  });

  it("runs the server's own deploy script from the same checkout", () => {
    expect(action).toContain("node scripts/deployment.ts deploy");
    expect(existsSync(new URL("../../scripts/deployment.ts", import.meta.url))).toBe(true);
    // setup-node's node-version-file is joined to the workspace, so the Action reads .nvmrc itself.
    expect(action).toContain('cat "$GITHUB_ACTION_PATH/../server/.nvmrc"');
    expect(action).toContain("node-version: ${{ steps.node.outputs.version }}");
    expect(action).not.toContain("node-version-file");
  });
});
