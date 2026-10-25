/**
 * JSON Schema (draft 2020-12) for the analysis document, emitted from the Zod schemas.
 *
 * Emitted from the input side: the audience is producers (models, other languages), and a
 * field with a default is one they may leave out. Constraints JSON Schema cannot express
 * (referential integrity, hunk membership, score bands) stay the parser's job and are listed
 * in docs/schema/analysis-document.md.
 */
import { z } from "zod";
import { AnalysisDocument, SCHEMA_VERSION } from "./document.js";
import { JsonValue, View } from "./graph.js";

export const JSON_SCHEMA_ID =
  "https://raw.githubusercontent.com/rocky-reviews/rocky/main/packages/schema/json-schema/analysis-document.schema.json";

// The drill-down tree and a JSON value are recursive, so they land in $defs; without an id
// each would be published under a generated name that changes with the schema.
z.globalRegistry.add(View, { id: "View" });
z.globalRegistry.add(JsonValue, { id: "JsonValue" });

/** Keys sorted at every level so the output is byte-identical whatever the object order. */
const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  return value;
};

/** The schema as an object; `emitJsonSchema` is the string form that goes to disk. */
export const buildJsonSchema = (): Record<string, unknown> =>
  sortKeys({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: JSON_SCHEMA_ID,
    title: "Rocky Reviews analysis document",
    version: SCHEMA_VERSION,
    ...z.toJSONSchema(AnalysisDocument, { target: "draft-2020-12", io: "input" }),
  }) as Record<string, unknown>;

export const emitJsonSchema = (): string => `${JSON.stringify(buildJsonSchema(), null, 2)}\n`;
