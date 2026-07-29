import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ConfigSchema, ReviewRequestSchema, ClaimMarkerSchema, ReviewResultSchema, LabelSpecSchema,
} from "../core/model.js";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");
mkdirSync(out, { recursive: true });

const entries: Array<[string, unknown]> = [
  ["config", ConfigSchema],
  ["review-request", ReviewRequestSchema],
  ["claim-marker", ClaimMarkerSchema],
  ["review-result", ReviewResultSchema],
  ["label-spec", LabelSpecSchema],
];

for (const [name, schema] of entries) {
  const json = zodToJsonSchema(schema as never, { name, target: "jsonSchema7" });
  writeFileSync(path.join(out, `${name}.schema.json`), JSON.stringify(json, null, 2) + "\n");
}
console.log(`Generated ${entries.length} schemas in ${out}`);
