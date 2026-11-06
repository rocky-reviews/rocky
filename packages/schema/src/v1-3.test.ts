import { describe, expect, it } from "vitest";
import {
  BASE_SCHEMA_VERSION,
  isSupportedVersion,
  MAP_SECTIONS_SCHEMA_VERSION,
  NO_LOGIC_SCHEMA_VERSION,
  requiredSchemaVersion,
} from "./document.js";
import { FLOW_MESSAGE_RULE, FlowMessage, FlowMessageBase, flowMessageConsistent } from "./graph.js";
import { applyKnownFields } from "./known-fields.js";
import { MapSectionUnavailableReason } from "./provenance.js";
import { expectAccepted, expectRejected, pr847, pr847WithSummary } from "./test-helpers.js";

/**
 * The fixture's views and second walkthrough step reference its flow, so a document without
 * flows must also lose those references; Rocky's own flows never carry views (H4-7).
 */
const withoutFlows = (doc: ReturnType<typeof pr847>) => {
  doc.graph!.flows = [];
  doc.graph!.views = [];
  delete doc.graph!.walkthrough;
  return doc;
};

/**
 * Schema 1.3 (H4-7): the flows and the walkthrough of the change map are drawn by their own
 * model calls, so each gets a pipeline-owned reason for being missing from a drawn map:
 * `provenance.flowsUnavailable` and `provenance.walkthroughUnavailable`. Additive: every 1.0,
 * 1.1 and 1.2 document still parses, and a document that uses neither field is stamped as
 * before (H4-5, S7). Schema 1.4 (H4-8, v1-4.test.ts) moved the current version on; 1.3 stays
 * the stamp for these two fields.
 */

describe("schema 1.3: version policy", () => {
  it("is 1.3.0 and still reads 1.0 to 1.2 documents; 1.5 is the newest minor read", () => {
    expect(MAP_SECTIONS_SCHEMA_VERSION).toBe("1.3.0");
    for (const version of ["1.0.0", "1.1.3", "1.2.0", "1.3.0"])
      expect(isSupportedVersion(version), version).toBe(true);
    for (const version of ["1.6.0", "1.10.0", "1.30.0", "2.0.0"])
      expect(isSupportedVersion(version), version).toBe(false);
    for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
      const doc = pr847();
      doc.schemaVersion = version;
      expectAccepted(doc);
    }
  });

  it("stamps 1.3.0 only on a document that uses a 1.3 field; no-logic stays 1.2.0 and the rest 1.1.0", () => {
    expect(requiredSchemaVersion({ provenance: {} })).toBe(BASE_SCHEMA_VERSION);
    expect(requiredSchemaVersion({})).toBe(BASE_SCHEMA_VERSION);
    expect(
      requiredSchemaVersion({ provenance: { graphUnavailable: { reason: "no-logic" } } }),
    ).toBe(NO_LOGIC_SCHEMA_VERSION);
    expect(requiredSchemaVersion({ provenance: { graphUnavailable: { reason: "timeout" } } })).toBe(
      BASE_SCHEMA_VERSION,
    );
    expect(requiredSchemaVersion({ provenance: { flowsUnavailable: { reason: "timeout" } } })).toBe(
      MAP_SECTIONS_SCHEMA_VERSION,
    );
    expect(
      requiredSchemaVersion({
        provenance: { walkthroughUnavailable: { reason: "analysis-failed" } },
      }),
    ).toBe(MAP_SECTIONS_SCHEMA_VERSION);
  });
});

describe("schema 1.3: provenance.flowsUnavailable and provenance.walkthroughUnavailable", () => {
  it("are accepted next to a drawn map that lacks the section, with the fixed reasons only", () => {
    expect(MapSectionUnavailableReason.options).toEqual([
      "analysis-failed",
      "too-large",
      "timeout",
    ]);
    for (const reason of MapSectionUnavailableReason.options) {
      const doc = withoutFlows(pr847());
      doc.provenance.flowsUnavailable = { reason };
      doc.provenance.walkthroughUnavailable = { reason };
      const value = expectAccepted(doc);
      expect(value.provenance.flowsUnavailable).toEqual({ reason });
      expect(value.provenance.walkthroughUnavailable).toEqual({ reason });
      expect(value.graph?.flows).toEqual([]);
      expect(value.graph?.walkthrough).toBeUndefined();
    }
  });

  it("refuses any other text, a detail, or an extra field: the UI's sentence is always Rocky's", () => {
    for (const planted of [
      { reason: "no-logic" },
      { reason: "The model refused." },
      { reason: "timeout", detail: "Retry later." },
      { reason: "timeout", retry: true },
      "timeout",
      {},
    ]) {
      const doc = withoutFlows(pr847());
      Object.assign(doc.provenance, { flowsUnavailable: planted });
      expectRejected(doc, "INVALID_SHAPE", undefined);
      const other = withoutFlows(pr847());
      Object.assign(other.provenance, { walkthroughUnavailable: planted });
      expectRejected(other, "INVALID_SHAPE", undefined);
    }
  });

  it("a section and the reason for its absence cannot both be present", () => {
    const flows = pr847();
    expect(flows.graph!.flows!.length).toBeGreaterThan(0);
    flows.provenance.flowsUnavailable = { reason: "timeout" };
    expectRejected(flows, "INVALID_SHAPE", "provenance.flowsUnavailable");

    const walkthrough = pr847();
    expect(walkthrough.graph!.walkthrough).toBeDefined();
    walkthrough.provenance.walkthroughUnavailable = { reason: "analysis-failed" };
    expectRejected(walkthrough, "INVALID_SHAPE", "provenance.walkthroughUnavailable");
  });

  it("a reason needs a drawn map: without a graph the map's own reason covers it", () => {
    const doc = pr847();
    delete doc.graph;
    doc.provenance.graphUnavailable = { reason: "timeout" };
    doc.provenance.flowsUnavailable = { reason: "timeout" };
    expectRejected(doc, "INVALID_SHAPE", "provenance.flowsUnavailable");

    const other = pr847();
    delete other.graph;
    other.provenance.walkthroughUnavailable = { reason: "timeout" };
    expectRejected(other, "INVALID_SHAPE", "provenance.walkthroughUnavailable");
  });

  it("the reasons live in provenance only; a model cannot place them elsewhere", () => {
    const top = pr847();
    Object.assign(top, { flowsUnavailable: { reason: "timeout" } });
    expectRejected(top, "INVALID_SHAPE", "");
    const inGraph = pr847();
    Object.assign(inGraph.graph!, { walkthroughUnavailable: { reason: "timeout" } });
    expectRejected(inGraph, "INVALID_SHAPE", "graph");
  });

  it("the overlay owns them: a model's reasons are replaced and its section is dropped beside a pipeline reason", () => {
    const doc = pr847WithSummary();
    const facts = { ...doc.provenance };
    const { briefing, triage, findings } = doc;
    // A map as Rocky's pipeline draws it: no views, and no step staged on a flow.
    const graph = {
      ...doc.graph!,
      views: [],
      walkthrough: {
        steps: doc.graph!.walkthrough!.steps.filter((step) => step.stage === undefined),
      },
    };
    // A model that claims the sections failed: the claim is overwritten by the facts.
    const claimed = applyKnownFields(
      {
        briefing,
        triage,
        findings,
        graph,
        provenance: {
          ...facts,
          flowsUnavailable: { reason: "timeout" },
          walkthroughUnavailable: { reason: "timeout" },
        },
      },
      facts,
    );
    const kept = expectAccepted(claimed);
    expect(kept.provenance.flowsUnavailable).toBeUndefined();
    expect(kept.provenance.walkthroughUnavailable).toBeUndefined();
    expect(kept.graph?.flows.length).toBeGreaterThan(0);
    expect(kept.graph?.walkthrough).toBeDefined();
    expect(kept.schemaVersion).toBe(BASE_SCHEMA_VERSION);
    // The pipeline recorded a failure: whatever the model returned for the section is dropped,
    // so a failed section can neither fail the review nor stand next to its reason.
    const failed = applyKnownFields(
      { briefing, triage, findings, graph },
      {
        ...facts,
        flowsUnavailable: { reason: "analysis-failed" },
        walkthroughUnavailable: { reason: "too-large" },
      },
    );
    const value = expectAccepted(failed);
    expect(value.graph?.flows).toEqual([]);
    expect(value.graph?.walkthrough).toBeUndefined();
    expect(value.provenance.flowsUnavailable).toEqual({ reason: "analysis-failed" });
    expect(value.provenance.walkthroughUnavailable).toEqual({ reason: "too-large" });
    expect(value.schemaVersion).toBe(MAP_SECTIONS_SCHEMA_VERSION);
    expect(graph?.flows?.length).toBeGreaterThan(0); // the model output itself is not mutated
    expect(graph?.walkthrough).toBeDefined();
  });
});

describe("schema 1.3: FlowMessageBase is FlowMessage without its consistency rule", () => {
  it("the base takes the same fields; the rule is re-applied by a projection", () => {
    const self = { id: "m", from: "a", to: "a", label: "loop", kind: "self", delta: "added" };
    const crossed = { ...self, to: "b" };
    expect(FlowMessageBase.safeParse(crossed).success).toBe(true);
    expect(FlowMessage.safeParse(crossed).success).toBe(false);
    expect(FlowMessage.safeParse(self).success).toBe(true);
    expect(flowMessageConsistent({ kind: "self", from: "a", to: "b" })).toBe(false);
    expect(flowMessageConsistent({ kind: "sync", from: "a", to: "a" })).toBe(false);
    expect(flowMessageConsistent({ kind: "sync", from: "a", to: "b" })).toBe(true);
    const projected = FlowMessageBase.omit({ payload: true }).refine(
      flowMessageConsistent,
      FLOW_MESSAGE_RULE,
    );
    expect(projected.safeParse(crossed).success).toBe(false);
    expect(projected.safeParse({ ...self, payload: {} }).success).toBe(false);
    expect(Object.keys(FlowMessageBase.shape)).toEqual(Object.keys(FlowMessage.shape));
  });
});
