import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schema from "../../drop.config.schema.json" with { type: "json" };

// Node-only: Ajv compiles validators with `new Function`, which Workers forbid. Used by
// scripts/check-config.ts and the config tests, never by the Worker.

// Both packages are CommonJS; under Node's ESM interop their exports sit on `.default`.
const ajv = new Ajv2020.default({ allErrors: true });
addFormats.default(ajv);

const validate = ajv.compile(schema);

export function configErrors(value: unknown): string[] {
  if (validate(value)) return [];
  return (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`);
}
