import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./document.js";
import { applyKnownFields, type KnownFacts } from "./known-fields.js";
import { parseAnalysisDocument } from "./parse.js";
import type { Provenance } from "./provenance.js";
import { expectAccepted, expectRejected, pr847 } from "./test-helpers.js";

const facts = (): KnownFacts => pr847().provenance;

/** What a model might send: the document minus the facts, plus some facts it made up. */
const modelOutput = () => {
  const doc = pr847();
  const { briefing, triage, findings, graph } = doc;
  return { briefing, triage, findings, graph };
};

describe("applyKnownFields", () => {
  it("adds provenance and the schema version to output that has neither", () => {
    const result = applyKnownFields(modelOutput(), facts()) as Record<string, unknown>;
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.provenance).toEqual(facts());
    expectAccepted(result);
  });

  it("overwrites model-supplied SHAs, repo, PR number, stats, hunks and timestamp", () => {
    const forged: Provenance = {
      ...pr847().provenance,
      repo: { owner: "evil", name: "repo" },
      pullRequest: { number: 1 },
      base: { sha: "f".repeat(40) },
      head: { sha: "e".repeat(40) },
      generatedAt: "1999-01-01T00:00:00.000Z",
      generator: { name: "model", roles: [] },
      unanalysed: [],
      files: pr847().provenance.files.map((file) => ({
        ...file,
        additions: 0,
        deletions: 0,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 10_000 }],
      })),
    };
    const result = applyKnownFields(
      { ...modelOutput(), provenance: forged, schemaVersion: "9.9.9" },
      facts(),
    ) as Record<string, unknown>;
    expect(result.provenance).toEqual(facts());
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expectAccepted(result);
  });

  it("a model cannot add files: a triage entry or finding outside the facts is rejected", () => {
    const output = modelOutput();
    output.triage.files.push({
      path: "src/planted.ts",
      score: 90,
      level: "critical",
      reason: "r",
      whatChanged: "w",
      whyThisLevel: "y",
      flags: [],
    });
    output.findings.push({
      id: "F11",
      severity: "low",
      confidence: 50,
      path: "src/planted.ts",
      range: { start: 1, end: 1 },
      title: "t",
      body: "b",
      memory: [],
      agentPrompt: "p",
    });
    const withForgedFacts = {
      ...output,
      provenance: {
        ...facts(),
        files: [
          ...facts().files,
          {
            path: "src/planted.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }],
          },
        ],
      },
    };
    const result = applyKnownFields(withForgedFacts, facts());
    const issues = expectRejected(result, "UNKNOWN_FILE", "triage.files[7].path");
    expect(
      issues.some((issue) => issue.code === "UNKNOWN_FILE" && issue.path === "findings[10].path"),
    ).toBe(true);
  });

  it("a model cannot hide a file by calling it unanalysed (reviewer's attack)", () => {
    // The model drops the critical auth file from triage, removes its findings and review-path
    // step, and declares it unanalysed. `unanalysed` is a fact: the overlay replaces it.
    const output = modelOutput();
    const critical = output.triage.files[0]!.path;
    output.triage.files = output.triage.files.slice(1);
    output.findings = output.findings.filter((finding) => finding.path !== critical);
    output.briefing.reviewPath = output.briefing.reviewPath.filter(
      (step) => step.path !== critical,
    );

    // Spelled where it used to live: now an unknown field.
    const inTriage = applyKnownFields(
      {
        ...output,
        triage: { ...output.triage, unanalysed: [{ path: critical, reason: "analysis-failed" }] },
      },
      facts(),
    );
    expectRejected(inTriage, "INVALID_SHAPE", "triage");

    // Spelled where it lives now: overwritten by the facts, so the file is simply missing.
    const inProvenance = applyKnownFields(
      {
        ...output,
        provenance: { ...facts(), unanalysed: [{ path: critical, reason: "analysis-failed" }] },
      },
      facts(),
    );
    const parsed = parseAnalysisDocument(inProvenance);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(
        parsed.error.issues.some(
          (issue) => issue.code === "TRIAGE_COVERAGE" && issue.message.includes(critical),
        ),
      ).toBe(true);
    }
    expect(
      (inProvenance as { provenance: { unanalysed: unknown[] } }).provenance.unanalysed,
    ).toEqual([]);
  });

  it("pipeline-declared unanalysed files are accepted and keep the model out of them", () => {
    const output = modelOutput();
    const critical = output.triage.files[0]!.path;
    output.triage.files = output.triage.files.slice(1);
    output.findings = output.findings.filter((finding) => finding.path !== critical);
    output.briefing.reviewPath = output.briefing.reviewPath.filter(
      (step) => step.path !== critical,
    );
    const known = { ...facts(), unanalysed: [{ path: critical, reason: "timeout" as const }] };
    const value = expectAccepted(applyKnownFields(output, known));
    expect(value.provenance.unanalysed[0]!.path).toBe(critical);
  });

  it("a model cannot remove files: a dropped triage entry fails coverage", () => {
    const output = modelOutput();
    output.triage.noise = [];
    const result = applyKnownFields(output, facts());
    expectRejected(result, "TRIAGE_COVERAGE", "triage");
  });

  it("a model cannot widen hunks to legitimise a line outside the diff", () => {
    const output = modelOutput();
    output.findings[0]!.range = { start: 500, end: 500 };
    const widened = {
      ...output,
      provenance: {
        ...facts(),
        files: facts().files.map((f) => ({
          ...f,
          hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1000 }],
        })),
      },
    };
    expectRejected(applyKnownFields(widened, facts()), "LINE_OUTSIDE_DIFF", "findings[0].range");
  });

  it("copies the facts, so mutating them afterwards does not change the document", () => {
    const known = facts();
    const result = applyKnownFields(modelOutput(), known) as { provenance: Provenance };
    known.files[0]!.additions = 999;
    expect(result.provenance.files[0]!.additions).toBe(33);
  });

  it("returns non-object output unchanged so the parser reports it", () => {
    for (const input of [null, undefined, "text", 1, [1]]) {
      expect(applyKnownFields(input, facts())).toBe(input);
      expect(parseAnalysisDocument(applyKnownFields(input, facts())).ok).toBe(false);
    }
  });

  it("does not mutate the model output", () => {
    const output = modelOutput();
    const before = structuredClone(output);
    applyKnownFields(output, facts());
    expect(output).toEqual(before);
  });
});
