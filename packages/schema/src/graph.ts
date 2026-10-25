/**
 * The change map: lanes, nodes, edges, flows, drill-down views and a walkthrough.
 *
 * Adapted from PR Lens (https://github.com/coldteadotai/pr-lens), MIT License,
 * Copyright (c) 2026 Coldtea AI. See NOTICE. Changes: text fields reject control characters,
 * limits live in limits.ts, file refs use Rocky's LineRange, lenses/layout/stats/cites dropped.
 */
import { z } from "zod";
import {
  MAX_BADGES_PER_NODE,
  MAX_EDGES,
  MAX_FILES_PER_EDGE,
  MAX_FILES_PER_NODE,
  MAX_FLOW_MESSAGES,
  MAX_FLOW_PARTICIPANTS,
  MAX_FLOWS,
  MAX_LABEL_LENGTH,
  MAX_LANE_ORDER,
  MAX_LANES,
  MAX_MESSAGE_REPEAT,
  MAX_NODES,
  MAX_PAYLOAD_SAMPLE_BYTES,
  MAX_PAYLOAD_SAMPLE_DEPTH,
  MAX_PAYLOAD_SHAPE_BYTES,
  MAX_SCOPE_EDGES,
  MAX_SCOPE_FLOWS,
  MAX_SCOPE_LANES,
  MAX_SCOPE_MESSAGES,
  MAX_SCOPE_NODES,
  MAX_SUMMARY_LENGTH,
  MAX_VIEW_CHILDREN,
  MAX_WALKTHROUGH_STEPS,
  MIN_FLOW_MESSAGES,
  MIN_FLOW_PARTICIPANTS,
  MIN_LANES,
  MIN_NODES,
  MIN_WALKTHROUGH_STEPS,
} from "./limits.js";
import { Delta, FileRef, hasForbiddenProseCharacters, Id, line, prose } from "./primitives.js";

const Label = line(MAX_LABEL_LENGTH, "Short single-line display label.");
const Summary = prose(MAX_SUMMARY_LENGTH, "One or two sentences of plain prose.");

/** Coarse on purpose: this drives the card icon and shape, never analysis. */
export const NodeKind = z.enum([
  "service",
  "app",
  "module",
  "function",
  "route",
  "job",
  "queue",
  "datastore",
  "cache",
  "external",
  "ui",
  "config",
  "test",
  "package",
  "other",
]);
export type NodeKind = z.infer<typeof NodeKind>;

export const Lane = z
  .strictObject({
    id: Id,
    label: Label,
    subtitle: Label.optional().describe("Secondary line in the lane header, e.g. the platform."),
    order: z
      .int()
      .min(0)
      .max(MAX_LANE_ORDER)
      .optional()
      .describe("Left-to-right placement. Ties fall back to array order."),
    delta: Delta.optional().describe("Set only when the lane itself is new or gone."),
    summary: Summary.optional(),
  })
  .describe("A grouping band of the diagram. Every node belongs to exactly one lane.");
export type Lane = z.infer<typeof Lane>;

export const GraphNode = z
  .strictObject({
    id: Id,
    label: Label,
    kind: NodeKind,
    delta: Delta,
    lane: Id.describe("Id of the lane this node sits in."),
    group: Id.optional().describe("Optional sub-cluster within the lane, e.g. a package."),
    subtitle: Label.optional().describe("Secondary line on the card, e.g. a path or signature."),
    summary: Summary.optional().describe("Body text for this node's drill-down section."),
    files: z
      .array(FileRef)
      .max(MAX_FILES_PER_NODE)
      .default([])
      .describe("Backing source locations, used for click-through and permalinks."),
    badges: z
      .array(Label)
      .max(MAX_BADGES_PER_NODE)
      .default([])
      .describe("Extra chips on the card, beyond the delta badge the renderer adds."),
  })
  .describe("A node in the change map.");
export type GraphNode = z.infer<typeof GraphNode>;

export const EdgeKind = z.enum([
  "call",
  "http",
  "rpc",
  "event",
  "queue",
  "data",
  "dependency",
  "render",
  "other",
]);
export type EdgeKind = z.infer<typeof EdgeKind>;

/** `hero` is the connection the change is really about; `muted` is context. */
export const EdgeEmphasis = z.enum(["normal", "hero", "muted"]);
export type EdgeEmphasis = z.infer<typeof EdgeEmphasis>;

export const GraphEdge = z
  .strictObject({
    id: Id,
    from: Id.describe("Source node id."),
    to: Id.describe("Target node id."),
    kind: EdgeKind,
    delta: Delta,
    label: Label.optional().describe("Text on the edge, e.g. a route or protocol."),
    emphasis: EdgeEmphasis.default("normal"),
    animated: z.boolean().default(false).describe("Render a travelling pulse along this edge."),
    summary: Summary.optional(),
    files: z.array(FileRef).max(MAX_FILES_PER_EDGE).default([]),
  })
  .describe("A directed connection between two nodes.");
export type GraphEdge = z.infer<typeof GraphEdge>;

/** `async` fires and forgets, `return` carries a result back, `self` never leaves the participant. */
export const MessageKind = z.enum(["sync", "async", "return", "self"]);
export type MessageKind = z.infer<typeof MessageKind>;

/**
 * Spelled out rather than `z.json()`: that one publishes its recursion under a generated
 * `$defs` name even when registered under an id.
 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValue: z.ZodType<JsonValue> = z
  .lazy(() =>
    z.union([
      z.null(),
      z.boolean(),
      z.number(),
      z.string(),
      z.array(JsonValue),
      z.record(z.string(), JsonValue),
    ]),
  )
  .describe("Any JSON value.");

/** Counted by hand so this file needs no platform types. */
export const byteLength = (text: string): number => {
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
};

/** A scalar is 0, `{}` or `[]` is 1, `{ a: [] }` is 2. */
export const jsonDepth = (value: JsonValue): number => {
  if (value === null || typeof value !== "object") return 0;
  let deepest = 0;
  for (const child of Array.isArray(value) ? value : Object.values(value))
    deepest = Math.max(deepest, jsonDepth(child));
  return 1 + deepest;
};

/** Every string inside a sample is rendered, so the prose rule applies to keys and leaves. */
export const jsonHasForbiddenCharacters = (value: JsonValue): boolean => {
  if (typeof value === "string") return hasForbiddenProseCharacters(value);
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(jsonHasForbiddenCharacters);
  return Object.entries(value).some(
    ([key, child]) => hasForbiddenProseCharacters(key) || jsonHasForbiddenCharacters(child),
  );
};

/** Keys that mean something to JavaScript consumers are refused outright rather than dropped. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const jsonHasUnsafeKeys = (value: JsonValue): boolean => {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(jsonHasUnsafeKeys);
  return Object.entries(value).some(
    ([key, child]) => UNSAFE_KEYS.has(key) || jsonHasUnsafeKeys(child),
  );
};

/** A root string is either JSON text, which belongs here as the value it spells, or a scalar nobody learns a shape from. */
const Sample = JsonValue.superRefine((value, context) => {
  if (typeof value === "string") {
    context.addIssue({ code: "custom", message: "must be an inline JSON value, not a string" });
    return;
  }
  if (byteLength(JSON.stringify(value)) > MAX_PAYLOAD_SAMPLE_BYTES)
    context.addIssue({
      code: "custom",
      message: `must be at most ${MAX_PAYLOAD_SAMPLE_BYTES} bytes when serialised`,
    });
  if (jsonDepth(value) > MAX_PAYLOAD_SAMPLE_DEPTH)
    context.addIssue({
      code: "custom",
      message: `must be at most ${MAX_PAYLOAD_SAMPLE_DEPTH} levels deep`,
    });
  if (jsonHasForbiddenCharacters(value))
    context.addIssue({ code: "custom", message: "must not contain control characters" });
  if (jsonHasUnsafeKeys(value))
    context.addIssue({
      code: "custom",
      message: "must not use the keys __proto__, constructor or prototype",
    });
});

/**
 * The JSON Schema cannot see the refine, so `not` restates it. It sits on the wrapper because
 * metadata on the recursive value makes the emitter inline the whole union beside its `$ref`.
 */
const sampleField = (description: string) =>
  Sample.optional().meta({ description, not: { type: "string" } });

export const PayloadSide = z
  .strictObject({
    type: Label.describe(
      "Type name a reader would recognise, e.g. Invitation. `void` for a side that carries nothing.",
    ),
    shape: prose(MAX_PAYLOAD_SHAPE_BYTES)
      .refine((text) => byteLength(text) <= MAX_PAYLOAD_SHAPE_BYTES, {
        message: `must be at most ${MAX_PAYLOAD_SHAPE_BYTES} bytes`,
      })
      .optional()
      .describe("Type signature as text, taken from the code's own types."),
    sample: sampleField("One exemplar instance after the change, as a JSON value."),
    before: sampleField("The same exemplar before the change, when it differs."),
    source: FileRef.optional().describe("Fixture or type the shape and sample were taken from."),
  })
  .meta({ dependentRequired: { before: ["sample"] } })
  .refine((side) => side.before === undefined || side.sample !== undefined, {
    message: "before needs a sample to differ from",
    path: ["before"],
  })
  .describe("What travels on one side of a flow step.");
export type PayloadSide = z.infer<typeof PayloadSide>;

export const Payload = z
  .strictObject({
    request: PayloadSide.optional().describe("What the step carries from `from` to `to`."),
    response: PayloadSide.optional().describe("What comes back, when something does."),
  })
  .meta({ anyOf: [{ required: ["request"] }, { required: ["response"] }] })
  .refine((payload) => payload.request !== undefined || payload.response !== undefined, {
    message: "a payload carries at least one side",
  })
  .describe("Sample traffic for one flow step.");
export type Payload = z.infer<typeof Payload>;

/** Order is the array position: an explicit step number could disagree with the list. */
export const FlowMessage = z
  .strictObject({
    id: Id,
    from: Id.describe("Participant node id the message originates from."),
    to: Id.describe("Participant node id the message arrives at. Equals `from` when kind is self."),
    label: Label,
    kind: MessageKind.default("sync"),
    delta: Delta,
    animated: z.boolean().default(true).describe("Whether the data-flow view pulses this step."),
    repeat: z
      .int()
      .min(1)
      .max(MAX_MESSAGE_REPEAT)
      .optional()
      .describe("Times the step occurs per run, e.g. 4 batched requests."),
    note: Summary.optional().describe("Aside rendered beside the step in the drill-down."),
    files: z.array(FileRef).max(MAX_FILES_PER_EDGE).default([]),
    payload: Payload.optional().describe("Sample traffic, for a step that moves data."),
  })
  .refine((message) => (message.kind === "self") === (message.from === message.to), {
    message: "kind 'self' and from === to must agree",
    path: ["kind"],
  })
  .describe("One ordered step in a flow.");
export type FlowMessage = z.infer<typeof FlowMessage>;

export const FlowParticipant = z
  .strictObject({
    node: Id.describe("Id of the graph node this column represents."),
    label: Label.optional().describe("Shorter name for the column when the node label is long."),
  })
  .describe("A column in the sequence diagram, ordered by array position.");
export type FlowParticipant = z.infer<typeof FlowParticipant>;

export const Flow = z
  .strictObject({
    id: Id,
    title: Label,
    summary: Summary.optional(),
    delta: Delta.default("modified"),
    participants: z.array(FlowParticipant).min(MIN_FLOW_PARTICIPANTS).max(MAX_FLOW_PARTICIPANTS),
    messages: z
      .array(FlowMessage)
      .min(MIN_FLOW_MESSAGES)
      .max(MAX_FLOW_MESSAGES)
      .describe("Ordered by array position."),
  })
  .describe("An ordered message sequence (data-flow view).");
export type Flow = z.infer<typeof Flow>;

/**
 * A view either shows the whole graph or a named selection. The two are distinct states
 * rather than "a selection that happens to be empty", so removing the last element a view
 * pointed at can never silently turn it into a view of everything.
 */
export const ViewScope = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("all") }),
    z
      .strictObject({
        kind: z.literal("selection"),
        lanes: z.array(Id).max(MAX_SCOPE_LANES).default([]),
        nodes: z.array(Id).max(MAX_SCOPE_NODES).default([]),
        edges: z.array(Id).max(MAX_SCOPE_EDGES).default([]),
        flows: z.array(Id).max(MAX_SCOPE_FLOWS).default([]),
      })
      .meta({
        anyOf: [
          { properties: { lanes: { minItems: 1 } }, required: ["lanes"] },
          { properties: { nodes: { minItems: 1 } }, required: ["nodes"] },
          { properties: { edges: { minItems: 1 } }, required: ["edges"] },
          { properties: { flows: { minItems: 1 } }, required: ["flows"] },
        ],
      })
      .refine(
        (scope) =>
          scope.lanes.length + scope.nodes.length + scope.edges.length + scope.flows.length > 0,
        { message: "a selection must name at least one element" },
      ),
  ])
  .describe("What a drill-down section shows.");
export type ViewScope = z.infer<typeof ViewScope>;

export type View = {
  id: string;
  title: string;
  summary?: string | undefined;
  scope: ViewScope;
  defaultOpen: boolean;
  children: View[];
};

export type ViewInput = {
  id: string;
  title: string;
  summary?: string | undefined;
  scope?: z.input<typeof ViewScope> | undefined;
  defaultOpen?: boolean | undefined;
  children?: ViewInput[] | undefined;
};

/** One node of the drill-down tree. Total count and depth are bounded by the integrity pass. */
export const View: z.ZodType<View, ViewInput> = z.lazy(() =>
  z
    .strictObject({
      id: Id,
      title: Label,
      summary: Summary.optional(),
      scope: ViewScope.default({ kind: "all" }),
      defaultOpen: z.boolean().default(false),
      children: z.array(View).max(MAX_VIEW_CHILDREN).default([]),
    })
    .describe("A drill-down section; children nest as further sections."),
);

/** The picture a walkthrough step plays over: a drill-down view, or one flow drawn on its own. */
export const StepStage = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("view"), view: Id.describe("Id of the view to draw.") }),
    z.strictObject({ kind: z.literal("flow"), flow: Id.describe("Id of the flow to draw.") }),
  ])
  .describe("Which diagram a walkthrough step plays over.");
export type StepStage = z.infer<typeof StepStage>;

/**
 * What a step points at inside its stage. `messages` names steps of a flow, so it only means
 * anything when the stage draws that flow; the integrity pass checks the pairing.
 */
export const StepFocus = z
  .discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("all") }),
    z
      .strictObject({
        kind: z.literal("selection"),
        lanes: z.array(Id).max(MAX_SCOPE_LANES).default([]),
        nodes: z.array(Id).max(MAX_SCOPE_NODES).default([]),
        edges: z.array(Id).max(MAX_SCOPE_EDGES).default([]),
        messages: z
          .array(Id)
          .max(MAX_SCOPE_MESSAGES)
          .default([])
          .describe("Steps of the flow on the stage."),
      })
      .meta({
        anyOf: [
          { properties: { lanes: { minItems: 1 } }, required: ["lanes"] },
          { properties: { nodes: { minItems: 1 } }, required: ["nodes"] },
          { properties: { edges: { minItems: 1 } }, required: ["edges"] },
          { properties: { messages: { minItems: 1 } }, required: ["messages"] },
        ],
      })
      .refine(
        (focus) =>
          focus.lanes.length + focus.nodes.length + focus.edges.length + focus.messages.length > 0,
        { message: "a selection must name at least one element" },
      ),
  ])
  .describe("What stays lit while a walkthrough step plays.");
export type StepFocus = z.infer<typeof StepFocus>;

export const WalkthroughStep = z
  .strictObject({
    id: Id,
    heading: line(48, "A step heading, short enough to read at a glance."),
    body: line(140, "A single line under the step heading."),
    stage: StepStage.optional(),
    focus: StepFocus.default({ kind: "all" }),
  })
  .describe(
    "One stop on the walkthrough: a heading, a line, and the part of a diagram it is about.",
  );
export type WalkthroughStep = z.infer<typeof WalkthroughStep>;

export const Walkthrough = z
  .strictObject({
    steps: z
      .array(WalkthroughStep)
      .min(MIN_WALKTHROUGH_STEPS)
      .max(MAX_WALKTHROUGH_STEPS)
      .describe("Ordered by array position."),
  })
  .describe("An ordered tour of the change map.");
export type Walkthrough = z.infer<typeof Walkthrough>;

export const Graph = z
  .strictObject({
    lanes: z.array(Lane).min(MIN_LANES).max(MAX_LANES),
    nodes: z.array(GraphNode).min(MIN_NODES).max(MAX_NODES),
    edges: z.array(GraphEdge).max(MAX_EDGES).default([]),
    flows: z.array(Flow).max(MAX_FLOWS).default([]),
    views: z.array(View).max(MAX_VIEW_CHILDREN).default([]),
    walkthrough: Walkthrough.optional(),
  })
  .describe("The change map: what the PR touches and how the pieces connect.");
export type Graph = z.infer<typeof Graph>;
export type GraphInput = z.input<typeof Graph>;
