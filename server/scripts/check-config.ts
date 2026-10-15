import { existsSync, readFileSync } from "node:fs";
import { lockErrors, type LockFile } from "./lock.ts";
import { deploymentPaths } from "./paths.ts";
import { configErrors } from "./validate-config.ts";

// Checks a deployment's drop.config.json against the schema and its lockfile against the config.
// `--deploy` also requires the Cloudflare resources setup records; developing Drop against the
// placeholders doesn't.
//
// Usage: npm run check:config [-- --deploy]   (DROP_DEPLOYMENT_DIR picks the deployment)

const paths = deploymentPaths();
const deploy = process.argv.includes("--deploy");

if (!existsSync(paths.config)) {
  console.error(`${paths.config} doesn't exist.`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(paths.config, "utf8"));
const schemaErrors = configErrors(config);
if (schemaErrors.length > 0) {
  console.error("drop.config.json does not match drop.config.schema.json:");
  for (const error of schemaErrors) console.error(`  ${error}`);
  process.exit(1);
}
const lock = existsSync(paths.lock) ? (JSON.parse(readFileSync(paths.lock, "utf8")) as LockFile) : undefined;
const errors = lockErrors(config, lock, { deploy });
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(`drop.config.json and drop.config.lock.json in ${paths.dir} are valid${deploy ? " for deploying" : ""}.`);
