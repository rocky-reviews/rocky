import { describe, expect, it } from "vitest";
import { isSupportedVersion, SCHEMA_VERSION } from "./document.js";
import { BriefingUnavailableReason, GraphUnavailableReason } from "./provenance.js";
import { expectAccepted, expectRejected, pr847 } from "./test-helpers.js";

/**
 * Schema 1.2 (H4-5): one new fixed reason for a missing change map, `no-logic`: the pull
 * request changes no code with behaviour (docs, tooling or CI only), so there was nothing to
 * map and no graph call was made. Additive: every 1.0 and 1.1 document still parses.
 */

describe("schema 1.2: version policy", () => {
  it("is 1.2.0 and still reads 1.0 and 1.1 documents, but no newer minor", () => {
    expect(SCHEMA_VERSION).toBe("1.2.0");
    expect(isSupportedVersion("1.0.0")).toBe(true);
    expect(isSupportedVersion("1.1.3")).toBe(true);
    expect(isSupportedVersion("1.2.0")).toBe(true);
    expect(isSupportedVersion("1.3.0")).toBe(false);
    expect(isSupportedVersion("1.10.0")).toBe(false);
    expect(isSupportedVersion("2.0.0")).toBe(false);
    for (const version of ["1.0.0", "1.1.0"]) {
      const doc = pr847();
      doc.schemaVersion = version;
      expectAccepted(doc);
    }
  });
});

describe("schema 1.2: provenance.graphUnavailable.reason no-logic", () => {
  it("is accepted for the change map", () => {
    const doc = pr847();
    delete doc.graph;
    doc.provenance.graphUnavailable = { reason: "no-logic" };
    expect(expectAccepted(doc).provenance.graphUnavailable).toEqual({ reason: "no-logic" });
    expect(GraphUnavailableReason.options).toEqual([
      "analysis-failed",
      "too-large",
      "timeout",
      "no-logic",
    ]);
  });

  it("is not a reason for a missing briefing: the briefing's reasons are unchanged", () => {
    const doc = pr847();
    doc.provenance.briefingUnavailable = { reason: "no-logic" } as never;
    expectRejected(doc, "INVALID_SHAPE", "provenance.briefingUnavailable.reason");
    expect(BriefingUnavailableReason.options).toEqual(["analysis-failed", "too-large", "timeout"]);
  });

  it("still refuses any other text, so the UI's sentence is always Rocky's", () => {
    const doc = pr847();
    delete doc.graph;
    doc.provenance.graphUnavailable = { reason: "no logic changed" } as never;
    expectRejected(doc, "INVALID_SHAPE", "provenance.graphUnavailable.reason");
  });
});
