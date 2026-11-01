import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import {
  isLlmCallError,
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
    const graphBytes = JSON.stringify(
      jsonSchemaOutputFormat(STAGE_CALLS.graph.output.jsonSchema as never).schema,
    ).length;
    expect(JSON.stringify(flows).length).toBeLessThan(graphBytes);
    expect(JSON.stringify(walkthrough).length).toBeLessThan(graphBytes / 4);
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
