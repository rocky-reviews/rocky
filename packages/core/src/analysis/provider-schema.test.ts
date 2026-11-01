import { Graph } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { outputSchema, GRAPH_OUTPUT, TRIAGE_OUTPUT } from "./outputs.js";
import { providerJsonSchema } from "./provider-schema.js";

/**
 * H4-4: the JSON Schema a role sends is the emitted Zod schema with one rewrite: a combinator
 * (`anyOf`/`oneOf`/`allOf`) that sits beside a `type` is a hand-written constraint on the typed
 * value (Zod never emits that shape; only `.meta()` does), and it moves into the description.
 * Validation is unchanged: the port's `parse` runs the Zod schema, never the sent schema.
 */

const PAYLOAD = {
  type: "object",
  description: "Sample traffic for one flow step.",
  properties: { request: { type: "string" }, response: { type: "string" } },
  additionalProperties: false,
  anyOf: [{ required: ["request"] }, { required: ["response"] }],
};

const typeBesideCombinator = (node: unknown, path = ""): string[] => {
  if (Array.isArray(node))
    return node.flatMap((entry, i) => typeBesideCombinator(entry, `${path}[${i}]`));
  if (typeof node !== "object" || node === null) return [];
  const schema = node as Record<string, unknown>;
  const here =
    typeof schema["type"] === "string" &&
    ["anyOf", "oneOf", "allOf"].some((key) => Array.isArray(schema[key]))
      ? [path]
      : [];
  return [
    ...here,
    ...Object.entries(schema).flatMap(([key, value]) =>
      typeBesideCombinator(value, `${path}/${key}`),
    ),
  ];
};

describe("providerJsonSchema (H4-4)", () => {
  it("moves a combinator beside a type into the description, in the SDK's own fold style", () => {
    expect(providerJsonSchema(PAYLOAD)).toEqual({
      type: "object",
      description:
        'Sample traffic for one flow step.\n\n{anyOf: [{"required":["request"]},{"required":["response"]}]}',
      properties: { request: { type: "string" }, response: { type: "string" } },
      additionalProperties: false,
    });
  });

  it("starts the description when there is none, and folds oneOf and allOf the same way", () => {
    const node = { type: "array", items: { type: "string" }, oneOf: [{ minItems: 1 }] };
    expect(providerJsonSchema(node)).toEqual({
      type: "array",
      items: { type: "string" },
      description: '{oneOf: [{"minItems":1}]}',
    });
    expect(providerJsonSchema({ type: "string", allOf: [{ minLength: 1 }] })).toEqual({
      type: "string",
      description: '{allOf: [{"minLength":1}]}',
    });
  });

  it("leaves a combinator without a sibling type alone: that is a union, not a constraint", () => {
    const union = { anyOf: [{ type: "string" }, { type: "null" }] };
    expect(providerJsonSchema(union)).toEqual(union);
    const tagged = {
      oneOf: [
        { type: "object", properties: { kind: { type: "string", const: "all" } } },
        { type: "object", properties: { kind: { type: "string", const: "selection" } } },
      ],
    };
    expect(providerJsonSchema(tagged)).toEqual(tagged);
  });

  it("rewrites at every schema position, including $defs, items, properties and union variants", () => {
    const nested = {
      $defs: { Step: { type: "object", properties: { payload: PAYLOAD } } },
      type: "object",
      properties: {
        steps: { type: "array", items: { $ref: "#/$defs/Step" } },
        either: { anyOf: [PAYLOAD, { type: "null" }] },
        extra: { type: "object", additionalProperties: PAYLOAD },
      },
    };
    const sent = providerJsonSchema(nested);
    expect(typeBesideCombinator(sent)).toEqual([]);
    expect(JSON.stringify(sent)).toContain('{anyOf: [{\\"required\\":[\\"request\\"]}');
    // The emitted schema is not changed in place.
    expect(typeBesideCombinator(nested)).toHaveLength(3);
  });

  it("does not treat the properties map or a default value as a schema", () => {
    const node = {
      type: "object",
      properties: {
        type: { type: "string" },
        anyOf: { type: "array", items: { type: "string" } },
      },
      default: { type: "x", anyOf: [{}] },
    };
    expect(providerJsonSchema(node)).toEqual(node);
  });

  it("is a no-op on a schema with nothing to rewrite, and returns an equal copy", () => {
    const triage = TRIAGE_OUTPUT.jsonSchema;
    expect(providerJsonSchema(triage)).toEqual(triage);
    expect(providerJsonSchema(triage)).not.toBe(triage);
  });
});

describe("the role contracts (H4-4)", () => {
  /**
   * The full graph (flows, views, walkthrough) is what carried the hand-written constraints. Since
   * H4-5 the graph role sends lanes, nodes and edges only, so the fold is exercised here on the
   * full document schema, which a later flows or views call would send.
   */
  const FULL_GRAPH = outputSchema("rocky_full_graph", Graph);

  it("send no type beside a combinator, while the graph's constraints stay in the description", () => {
    expect(typeBesideCombinator(GRAPH_OUTPUT.jsonSchema)).toEqual([]);
    // Nothing to fold in what the graph role sends today (H4-5): no description carries a fold.
    expect(JSON.stringify(GRAPH_OUTPUT.jsonSchema)).not.toContain("{anyOf:");
    expect(typeBesideCombinator(FULL_GRAPH.jsonSchema)).toEqual([]);
    const text = JSON.stringify(FULL_GRAPH.jsonSchema);
    expect(text).toContain('{anyOf: [{\\"required\\":[\\"request\\"]}');
    expect(text).toContain(
      '{\\"properties\\":{\\"lanes\\":{\\"minItems\\":1}},\\"required\\":[\\"lanes\\"]}',
    );
    // The raw emission still carries the constraints as schema: they moved, they were not lost.
    const raw = z.toJSONSchema(Graph, { target: "draft-2020-12", io: "input" });
    expect(typeBesideCombinator(raw).length).toBeGreaterThanOrEqual(3);
  });

  it("still validates what the moved constraints say (validation is the Zod schema's, not the sent schema's)", () => {
    const base = {
      lanes: [{ id: "l1", label: "API" }],
      nodes: [{ id: "n1", label: "Route", kind: "route", delta: "modified", lane: "l1" }],
    };
    const flow = (payload: unknown) => ({
      ...base,
      flows: [
        {
          id: "f1",
          title: "Login",
          participants: [{ node: "n1" }, { node: "n1" }],
          messages: [
            {
              id: "m1",
              from: "n1",
              to: "n1",
              kind: "self",
              label: "call",
              delta: "added",
              payload,
            },
          ],
        },
      ],
    });
    expect(FULL_GRAPH.parse(flow({ request: { type: "Login" } })).success).toBe(true);
    const empty = FULL_GRAPH.parse(flow({}));
    expect(empty.success).toBe(false);
    if (!empty.success) expect(empty.issues.join("\n")).toMatch(/payload/);

    const view = (scope: unknown) => ({
      ...base,
      views: [{ id: "v1", title: "All", scope }],
    });
    expect(FULL_GRAPH.parse(view({ kind: "selection", nodes: ["n1"] })).success).toBe(true);
    const unselected = FULL_GRAPH.parse(view({ kind: "selection" }));
    expect(unselected.success).toBe(false);
    if (!unselected.success) expect(unselected.issues.join("\n")).toMatch(/views\[0\]\.scope/);
  });

  it("outputSchema applies the rewrite to any stage schema", () => {
    const Sided = z
      .strictObject({ a: z.string().optional(), b: z.string().optional() })
      .meta({ anyOf: [{ required: ["a"] }, { required: ["b"] }] })
      .refine((v) => v.a !== undefined || v.b !== undefined);
    const output = outputSchema("sided", Sided);
    expect(output.jsonSchema["anyOf"]).toBeUndefined();
    expect(output.jsonSchema["description"]).toContain('{anyOf: [{"required":["a"]}');
    expect(output.parse({}).success).toBe(false);
    expect(output.parse({ a: "x" }).success).toBe(true);
    expect(Object.isFrozen(output.jsonSchema)).toBe(true);
  });
});
