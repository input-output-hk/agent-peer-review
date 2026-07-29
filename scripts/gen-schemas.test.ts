// scripts/gen-schemas.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ClaimMarkerSchema } from "../core/model.js";

describe("schema generation", () => {
  it("committed claim-marker schema matches the zod source", () => {
    const expected = JSON.stringify(
      zodToJsonSchema(ClaimMarkerSchema as never, { name: "claim-marker", target: "jsonSchema7" }), null, 2) + "\n";
    const actual = readFileSync("schemas/claim-marker.schema.json", "utf8");
    expect(actual).toBe(expected);
  });
});
