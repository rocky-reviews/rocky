import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import {
  ASK_OUTPUT,
  isLlmCallError,
  REVIEW_MEMORY_OUTPUT,
  rockyInstructions,
  STAGE_CALLS,
  type LlmOutputSchema,
} from "@rocky-reviews/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envSecrets } from "../registry.js";
import { providerAdapters } from "./index.js";
import { fakeFetch, OTHER_KEY, TEST_KEY } from "./test-support.js";

/**
 * H4-4: the schema every role sends must survive the SDK's structured-output transform
 * (`jsonSchemaOutputFormat` → `transformJSONSchema`), which refuses any subschema without a
 * `type` or a combinator. The graph role's hand-written "at least one of" constraints (sibling
 * `anyOf` on a typed object) tripped it, so every real analysis failed as `internal_error`
 * before a request was sent. This runs the SDK's own transform, not a copy of it.
 */

const STAGES = Object.entries(STAGE_CALLS);

/** Optional parameters in a sent schema, the API's published limit being 24 (ADR 0013 H4-4). */
const optionalCount = (sent: unknown): number => {
  let optional = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const schema = node as { properties?: Record<string, unknown>; required?: string[] };
    if (schema.properties !== undefined) {
      const required = new Set(schema.required ?? []);
      optional += Object.keys(schema.properties).filter((key) => !required.has(key)).length;
    }
    Object.values(node).forEach(walk);
  };
  walk(sent);
  return optional;
};

/** Keywords the provider reads as text, not as grammar. */
const PROSE = new Set(["description", "title", "examples", "$schema"]);

/**
 * A description-free size of a sent schema: one per property name, `type`, and `enum` or `const`
 * literal. A proxy for the compiled grammar (ADR 0013 H4-4, limit 3, has no offline oracle), used
 * only to compare schemas with each other.
 */
const grammarWeight = (sent: unknown): number => {
  let weight = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (PROSE.has(key)) continue;
      if (key === "properties" && typeof value === "object" && value !== null) {
        weight += Object.keys(value).length;
        Object.values(value).forEach(walk);
      } else if (key === "enum" && Array.isArray(value)) weight += value.length;
      else if (key === "type" || key === "const") weight += 1;
      else walk(value);
    }
  };
  walk(sent);
  return weight;
};

/** Every `enum` in a schema, in document order (property maps walked by key). */
const enumsIn = (schema: unknown): unknown[][] => {
  const found: unknown[][] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (PROSE.has(key)) continue;
      // A property may itself be named `title` or `description`: walk the map's values.
      if (key === "properties" && typeof value === "object" && value !== null)
        Object.values(value).forEach(walk);
      else if (key === "enum" && Array.isArray(value)) found.push(value);
      else walk(value);
    }
  };
  walk(schema);
  return found;
};

describe("every role's output schema goes through the SDK's structured-output transform (H4-4)", () => {
  it.each(STAGES)("%s", (_stage, template) => {
    expect(() => jsonSchemaOutputFormat(template.output.jsonSchema as never)).not.toThrow();
  });

  it("the transformed schema keeps every object closed and typed, and no definition refers to itself", () => {
    for (const [, template] of STAGES) {
      const sent = jsonSchemaOutputFormat(template.output.jsonSchema as never).schema;
      // The API refuses a circular `$defs` reference in an enforced schema ("Self-referencing or
      // mutually-referencing definitions are not supported"): checked offline here, as the real
      // API did once. Every role is enforced since H4-5 (the graph asks for lanes, nodes and
      // edges only), so the check runs on all of them.
      expect(template.output.mode).toBe("structured");
      const defs = (sent["$defs"] ?? {}) as Record<string, unknown>;
      const refs = (node: unknown, out = new Set<string>()): Set<string> => {
        if (Array.isArray(node)) node.forEach((entry) => refs(entry, out));
        else if (typeof node === "object" && node !== null) {
          const ref = (node as { $ref?: unknown })["$ref"];
          if (typeof ref === "string") out.add(ref.replace("#/$defs/", ""));
          Object.values(node).forEach((value) => refs(value, out));
        }
        return out;
      };
      for (const start of Object.keys(defs)) {
        const seenDefs = new Set<string>();
        const stack = [...refs(defs[start])];
        while (stack.length > 0) {
          const name = stack.pop()!;
          expect(name, `${template.output.name}: ${start} reaches itself`).not.toBe(start);
          if (seenDefs.has(name)) continue;
          seenDefs.add(name);
          stack.push(...refs(defs[name]));
        }
      }
      const seen: string[] = [];
      const walk = (node: unknown, path: string): void => {
        if (Array.isArray(node)) {
          node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
          return;
        }
        if (typeof node !== "object" || node === null) return;
        const schema = node as Record<string, unknown>;
        const typed = "type" in schema || "$ref" in schema;
        const combined = ["anyOf", "oneOf", "allOf"].some((key) => Array.isArray(schema[key]));
        if (typed && combined) seen.push(`${path}: type beside a combinator`);
        if (schema["type"] === "object" && schema["additionalProperties"] !== false)
          seen.push(`${path}: open object`);
        for (const [key, value] of Object.entries(schema)) walk(value, `${path}/${key}`);
      };
      walk(sent, template.output.name);
      expect(seen).toEqual([]);
    }
  });
});

describe("the Ask answer (P9-2)", () => {
  it("compiles through the SDK's transform as an enforced output, every object closed", () => {
    expect(ASK_OUTPUT.mode).toBe("structured");
    const sent = jsonSchemaOutputFormat(ASK_OUTPUT.jsonSchema as never).schema;
    expect(optionalCount(sent)).toBe(0);
    const open: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((entry, i) => walk(entry, `${path}[${i}]`));
      if (typeof node !== "object" || node === null) return;
      const schema = node as Record<string, unknown>;
      if (schema["type"] === "object" && schema["additionalProperties"] !== false) open.push(path);
      for (const [key, value] of Object.entries(schema)) walk(value, `${path}/${key}`);
    };
    walk(sent, "rocky_ask");
    expect(open).toEqual([]);
  });
});

describe("the review with project memory (P8-2)", () => {
  it("compiles through the SDK's transform as an enforced output, inside the optional-field limit", () => {
    expect(REVIEW_MEMORY_OUTPUT.mode).toBe("structured");
    const sent = jsonSchemaOutputFormat(REVIEW_MEMORY_OUTPUT.jsonSchema as never).schema;
    expect(optionalCount(sent)).toBeLessThanOrEqual(24);
    expect(optionalCount(sent)).toBe(
      optionalCount(jsonSchemaOutputFormat(STAGE_CALLS.review.output.jsonSchema as never).schema),
    );
    expect(JSON.stringify(sent)).toMatch(/"suppressed"/);
    expect(JSON.stringify(sent)).not.toMatch(/"memoryApplied"/);
  });
});

describe("which roles the provider enforces (H4-4, H4-5)", () => {
  it("every role is enforced, the graph included (lanes, nodes and edges compile)", () => {
    expect(
      Object.fromEntries(STAGES.map(([stage, template]) => [stage, template.output.mode])),
    ).toEqual({
      triage: "structured",
      review: "structured",
      graph: "structured",
      flows: "structured",
      walkthrough: "structured",
      briefing: "structured",
    });
  });

  it("the graph schema stays inside the API's published complexity limits (H4-5)", () => {
    // ADR 0013 amendment H4-4: at most 24 optional parameters and no recursive definition. The
    // grammar-size limit has no offline oracle; the real run is its evidence (docs/progress.md).
    const sent = jsonSchemaOutputFormat(STAGE_CALLS.graph.output.jsonSchema as never).schema;
    expect(optionalCount(sent)).toBeLessThanOrEqual(24);
    expect(JSON.stringify(sent)).not.toMatch(/"flows"|"views"|"walkthrough"|JsonValue|"View"/);
  });

  it("the flows and walkthrough schemas compile on their own, without the payload's recursive sample (H4-7)", () => {
    const flows = jsonSchemaOutputFormat(STAGE_CALLS.flows.output.jsonSchema as never).schema;
    expect(optionalCount(flows)).toBeLessThanOrEqual(24);
    expect(JSON.stringify(flows)).not.toMatch(/"payload"|JsonValue|"views"|"walkthrough"|"\$defs"/);
    expect(JSON.stringify(flows)).toMatch(/"participants"/);
    const walkthrough = jsonSchemaOutputFormat(
      STAGE_CALLS.walkthrough.output.jsonSchema as never,
    ).schema;
    expect(optionalCount(walkthrough)).toBeLessThanOrEqual(24);
    expect(JSON.stringify(walkthrough)).not.toMatch(/"stage"|"messages"|"lanes"|"\$defs"|anyOf/);
    expect(JSON.stringify(walkthrough)).toMatch(/"heading"/);
    // Each is a fraction of the graph's grammar, which compiled on the real provider (H4-5).
    // Measured on what the provider compiles, not on the JSON's length: descriptions (and the
    // constraints the SDK folds into them) are prose, so rewording one, or an SDK moving a
    // keyword between the prose and the schema, must not move the comparison.
    const graph = grammarWeight(
      jsonSchemaOutputFormat(STAGE_CALLS.graph.output.jsonSchema as never).schema,
    );
    expect(grammarWeight(flows)).toBeLessThan(graph);
    expect(grammarWeight(walkthrough)).toBeLessThan(graph / 4);
  });
});

describe("enums reach the provider as constraints (SDK 1.7+)", () => {
  // `@anthropic-ai/sdk` 1.7.0 ("keep const and enum in structured output schemas") sends a
  // primitive `enum` as is, where 1.6.0 dropped it to `type: "string"` plus `{enum: [...]}` in
  // the description. The provider now enforces the values; the Zod validator is unchanged.
  const ROLES: [string, LlmOutputSchema<unknown>][] = [
    ...STAGES.map(([stage, template]): [string, LlmOutputSchema<unknown>] => [
      stage,
      template.output,
    ]),
    ["ask", ASK_OUTPUT],
    ["memory", REVIEW_MEMORY_OUTPUT],
  ];

  it.each(ROLES)("%s: every enum Zod emits is sent as an enum, none as prose", (_role, output) => {
    const sent = jsonSchemaOutputFormat(output.jsonSchema as never).schema;
    expect(enumsIn(sent)).toEqual(enumsIn(output.jsonSchema));
    expect(JSON.stringify(sent)).not.toMatch(/\{(default: [^,]*, )?enum: /);
  });

  it("the triage, review, graph and flows schemas carry enums, so the check above has teeth", () => {
    for (const stage of ["triage", "review", "graph", "flows"] as const)
      expect(enumsIn(STAGE_CALLS[stage].output.jsonSchema).length, stage).toBeGreaterThan(0);
  });
});

describe("the briefing's TL;DR schema (H4-8)", () => {
  it("compiles through the SDK's transform with the TL;DR required, the summary gone and the limits kept", () => {
    const sent = jsonSchemaOutputFormat(STAGE_CALLS.briefing.output.jsonSchema as never).schema as {
      required: string[];
      properties: Record<string, { description?: string; items?: { description?: string } }>;
    };
    expect(optionalCount(sent)).toBeLessThanOrEqual(24);
    expect(sent.required).toEqual(expect.arrayContaining(["tldr", "verdict", "reviewPath"]));
    expect(Object.keys(sent.properties)).not.toContain("summary");
    // The SDK strips the array and string limits into the description, where the model reads them.
    const tldr = sent.properties["tldr"]!;
    expect(tldr.description).toMatch(/two to four one-sentence bullets/);
    expect(tldr.description).toContain("maxItems: 4");
    expect(tldr.description).toContain("minItems: 2");
    expect(tldr.items?.description).toContain("maxLength: 160");
    expect(JSON.stringify(sent.properties["verdict"])).toContain("maxLength: 200");
    expect(JSON.stringify(sent)).not.toMatch(/anyOf|"\$defs"/);
  });
});

describe("a schema the SDK's transform refuses fails closed before any request (H4-4)", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", OTHER_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is invalid_request with the origin tag, nothing is sent, and the port's error carries no text", async () => {
    // A typed object whose sibling `anyOf` has typeless variants: what the graph schema used to be.
    const refused: LlmOutputSchema<unknown> = {
      name: "refused",
      jsonSchema: {
        type: "object",
        properties: { request: { type: "string" }, response: { type: "string" } },
        additionalProperties: false,
        anyOf: [{ required: ["request"] }, { required: ["response"] }],
      },
      parse: (value) => ({ success: true, data: value }),
    };
    const fake = fakeFetch();
    const adapters = providerAdapters({ fetch: fake.fetch, maxRetries: 0 });
    const provider = adapters.anthropic!(
      { kind: "anthropic", apiKeyEnv: "ROCKY_TEST_ANTHROPIC_KEY" },
      envSecrets({ ROCKY_TEST_ANTHROPIC_KEY: TEST_KEY }),
    );
    let thrown: unknown;
    try {
      await provider.completeStructured!({
        role: "graph",
        model: "claude-sonnet-5-5",
        platformModel: undefined,
        effort: undefined,
        instructions: rockyInstructions`Draw the change map.`,
        untrusted: [{ label: "diff", text: "+secret diff line" }],
        output: refused,
        maxOutputTokens: 1024,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isLlmCallError(thrown)).toBe(true);
    if (!isLlmCallError(thrown)) return;
    expect(thrown.kind).toBe("invalid_request");
    expect(thrown.origin).toBe("sdk_schema_transform");
    expect(thrown.cause).toBeUndefined();
    expect(thrown.message).not.toMatch(/anyOf|secret|type defined/);
    expect(fake.requests).toHaveLength(0);
  });
});
