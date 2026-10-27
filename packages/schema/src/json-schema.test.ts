import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./document.js";
import { buildJsonSchema, emitJsonSchema, JSON_SCHEMA_ID } from "./json-schema.js";

const committed = () =>
  readFileSync(new URL("../json-schema/analysis-document.schema.json", import.meta.url), "utf8");

describe("JSON Schema emit", () => {
  it("is deterministic: two builds are byte-identical", () => {
    expect(emitJsonSchema()).toBe(emitJsonSchema());
  });

  it("matches the committed file (run `pnpm schema:emit` after changing the schemas)", () => {
    expect(committed()).toBe(emitJsonSchema());
  });

  it("targets draft 2020-12 and carries the id, title and contract version", () => {
    const schema = buildJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(JSON_SCHEMA_ID);
    expect(schema.version).toBe(SCHEMA_VERSION);
    expect(schema.title).toBe("Rocky Reviews analysis document");
  });

  it("keeps strictness and limits visible to other producers", () => {
    const schema = buildJsonSchema() as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<
        string,
        {
          pattern?: string;
          items?: { properties?: Record<string, { pattern?: string; maxLength?: number }> };
          maxItems?: number;
        }
      >;
      $defs: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual([
      "briefing",
      "findings",
      "provenance",
      "schemaVersion",
      "triage",
    ]);
    expect(schema.properties.schemaVersion!.pattern).toBe("^1\\.(0|1)\\.\\d+$");
    expect(schema.properties.findings!.maxItems).toBe(200);
    expect(schema.properties.findings!.items!.properties!.path!.maxLength).toBe(1024);
    expect(Object.keys(schema.$defs).sort()).toEqual(["JsonValue", "View"]);
  });

  it("sorts object keys at every level", () => {
    const text = emitJsonSchema();
    const keysInOrder = (object: unknown): boolean => {
      if (Array.isArray(object)) return object.every(keysInOrder);
      if (typeof object !== "object" || object === null) return true;
      const keys = Object.keys(object);
      return keys.every(
        (key, i) =>
          (i === 0 || key > keys[i - 1]!) && keysInOrder((object as Record<string, unknown>)[key]),
      );
    };
    expect(keysInOrder(JSON.parse(text))).toBe(true);
  });
});
