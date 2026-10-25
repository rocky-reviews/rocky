import { describe, expect, it } from "vitest";
import {
  buildLargeFixture,
  FILE_COUNT,
  NOISE_COUNT,
  UNANALYSED_COUNT,
} from "./fixtures/large-60-files.js";
import { parseAnalysisDocument } from "./parse.js";
import { expectAccepted, FIXTURES, loadFixture } from "./test-helpers.js";

describe("golden fixtures", () => {
  it.each(FIXTURES)("%s validates", (name) => {
    expectAccepted(loadFixture(name));
  });

  it.each(FIXTURES)("%s is stored in canonical form (parsing changes nothing)", (name) => {
    const raw = loadFixture(name);
    expect(expectAccepted(raw)).toEqual(raw);
  });

  it("pr-847 carries everything the POC shows", () => {
    const doc = expectAccepted(loadFixture("pr-847"));
    expect(doc.provenance.pullRequest.number).toBe(847);
    expect(doc.provenance.files).toHaveLength(9);
    expect(doc.triage.files).toHaveLength(7);
    expect(doc.triage.noise).toHaveLength(2);
    expect(doc.findings).toHaveLength(10);
    expect(doc.findings.filter((finding) => finding.suggestion)).toHaveLength(6);
    expect(doc.findings.filter((finding) => finding.memory.length > 0)).toHaveLength(4);
    expect(doc.graph!.lanes.map((lane) => lane.label)).toEqual(["WEB", "API", "DATA", "WORKERS"]);
    expect(doc.graph!.nodes).toHaveLength(7);
    expect(doc.graph!.edges).toHaveLength(7);
    expect(doc.graph!.edges.filter((edge) => edge.emphasis === "hero")).toHaveLength(2);
    expect(doc.briefing.memoryApplied).toHaveLength(4);
    expect(doc.briefing.checkedOk).toHaveLength(4);
    expect(doc.briefing.reviewPath).toHaveLength(4);
    expect(doc.briefing.estimatedReviewMinutes).toBe(7);
    expect(doc.briefing.verdict.level).toBe("high");
  });

  it("tiny is a one-file PR with no findings and no graph", () => {
    const doc = expectAccepted(loadFixture("tiny"));
    expect(doc.provenance.files).toHaveLength(1);
    expect(doc.findings).toEqual([]);
    expect(doc.graph).toBeUndefined();
  });

  it("large-60-files is what the deterministic builder produces", () => {
    const built = parseAnalysisDocument(buildLargeFixture());
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(built.value).toEqual(loadFixture("large-60-files"));
    expect(built.value.provenance.files).toHaveLength(FILE_COUNT);
    expect(built.value.triage.noise).toHaveLength(NOISE_COUNT);
    expect(built.value.provenance.unanalysed).toHaveLength(UNANALYSED_COUNT);
    expect(built.value.triage.files).toHaveLength(FILE_COUNT - NOISE_COUNT - UNANALYSED_COUNT);
    expect(built.value.findings.length).toBeGreaterThan(10);
  });

  it("the builder is deterministic across calls", () => {
    expect(buildLargeFixture()).toEqual(buildLargeFixture());
  });
});
