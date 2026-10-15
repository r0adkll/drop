import { existsSync, readFileSync } from "node:fs";
import { lockErrors, type LockFile } from "./lock.ts";
import { configErrors } from "./validate-config.ts";

const configPath = new URL("../../drop.config.json", import.meta.url);
const lockPath = new URL("../../drop.config.lock.json", import.meta.url);

const config = JSON.parse(readFileSync(configPath, "utf8"));
const schemaErrors = configErrors(config);
if (schemaErrors.length > 0) {
  console.error("drop.config.json does not match drop.config.schema.json:");
  for (const error of schemaErrors) console.error(`  ${error}`);
  process.exit(1);
}
const lock = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, "utf8")) as LockFile) : undefined;
const errors = lockErrors(config, lock);
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log("drop.config.json and drop.config.lock.json are valid.");
