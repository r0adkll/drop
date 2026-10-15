import { readFileSync } from "node:fs";
import { configErrors } from "./validate-config.ts";

const path = new URL("../../drop.config.json", import.meta.url);
const errors = configErrors(JSON.parse(readFileSync(path, "utf8")));

if (errors.length > 0) {
  console.error("drop.config.json does not match drop.config.schema.json:");
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log("drop.config.json is valid.");
