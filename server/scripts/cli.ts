// The commands a deployment repository's ./drop script runs. The script only reads the pinned Drop
// release, brings its cached checkout up to date and hands every command here, so a command added
// to Drop reaches deployments when they move their pin, without a new copy of the script.
//
// Usage (from the script): node scripts/cli.ts <command> [options], with DROP_DEPLOYMENT_DIR set.
// Kept free of imports from the rest of server/ so the script's tests can run it on its own.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATE_SCRIPT = fileURLToPath(new URL("../../deployment/template/drop", import.meta.url));

const USAGE = `Usage: ./drop <command> [options]

Commands:
  setup [options]    Set up or repair this deployment: Cloudflare account, D1 database, R2 bucket and
                     token, Owner IDs, GitHub App, first deploy and CI credentials. Safe to re-run.
                     Options: --refresh, --skip-app, --recreate-app, --app-name <name>,
                     --worker-name <name>, --push-secrets
  deploy [options]   Deploy from this machine. CI deploys every push to main.
                     Options: --secrets (upload .dev.vars too), --dry-run
  dev [args]         Run the Worker locally with wrangler dev; extra arguments go to wrangler.
  delete-build <id>  Remove a Build now, such as one that leaked a secret: its page says it was
                     removed and its APK is deleted. Options: --yes (skip the confirmation)
  self-update        Replace this ./drop script with the pinned Drop release's copy.
  version            Print the Drop repository and ref this deployment pins.
  help               Show this help.`;

function node(script: string, args: string[]): number {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { stdio: "inherit" }).status ?? 1;
}

function main(): number {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "setup":
      return node("setup.ts", args);
    case "deploy":
    case "dev":
    case "delete-build":
      return node("deployment.ts", [command, ...args]);
    case "self-update": {
      const deployment = process.env.DROP_DEPLOYMENT_DIR;
      if (!deployment) {
        console.error("DROP_DEPLOYMENT_DIR isn't set; run this through ./drop.");
        return 1;
      }
      const target = join(deployment, "drop");
      copyFileSync(TEMPLATE_SCRIPT, target);
      chmodSync(target, 0o755);
      console.log("Updated ./drop from the pinned Drop release. Commit it.");
      return 0;
    }
    case "help":
    case "-h":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

process.exit(main());
