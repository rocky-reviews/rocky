import { describe, expect, it } from "vitest";
import {
  AnalysisDocument,
  isSupportedVersion,
  requiredSchemaVersion,
  RESTORED_SCHEMA_VERSION,
  SCHEMA_VERSION,
  TLDR_SCHEMA_VERSION,
} from "./document.js";
import { HiddenFinding } from "./findings.js";
import { applyKnownFields } from "./known-fields.js";
import {
  expectAccepted,
  expectRejected,
  pr847,
  pr847v14,
  pr847v15,
  pr847WithSummary,
} from "./test-helpers.js";

/**
 * Schema 1.6 (P8-2b, ADR 0037 §7): `hidden`, the findings a project-memory dismissal kept out
 * of the drafts, written by the pipeline so that a suppression is never invisible: the page
 * lists them collapsed and the reviewer can restore one as a draft. Additive for readers: every
 * 1.0 to 1.5 document still parses, and a document without a hidden finding is stamped as
 * before.
 */

const HIDDEN_BY = {
  entry: {
    entryId: "mem-770",
    text: "Dismissed as intentional: Invite emails are not retried on a transient send failure",
    source: "dismissal · PR #770",
  },
  path: "src/jobs/sendInviteEmail.ts",
  dismissedAs: "intentional",
} as const;

const JOBS = "src/jobs/sendInviteEmail.ts";

const hiddenOf = (doc: ReturnType<typeof pr847>) => doc.hidden?.[0];

describe("schema 1.6: version policy", () => {
  it("is 1.6.0 and still reads 1.0 to 1.5 documents, but no newer minor", () => {
    expect(SCHEMA_VERSION).toBe("1.6.0");
    for (const version of ["1.0.0", "1.1.3", "1.4.0", "1.5.0", "1.5.9", "1.6.0", "1.6.2"])
      expect(isSupportedVersion(version), version).toBe(true);
    for (const version of ["1.7.0", "1.60.0", "2.0.0"])
      expect(isSupportedVersion(version), version).toBe(false);
  });

  it("stamps 1.6.0 only on a document that lists a hidden finding, and the older stamps otherwise", () => {
    const tldr = { tldr: ["a", "b"] };
    expect(requiredSchemaVersion({ briefing: tldr, findings: [], hidden: [{}] })).toBe(
      SCHEMA_VERSION,
    );
    // An empty list needs nothing newer: the pipeline leaves it out, and a 1.5 reader reads on.
    expect(requiredSchemaVersion({ briefing: tldr, findings: [], hidden: [] })).toBe(
      TLDR_SCHEMA_VERSION,
    );
    expect(
      requiredSchemaVersion({ briefing: tldr, findings: [{ restored: {} }], hidden: [] }),
    ).toBe(RESTORED_SCHEMA_VERSION);
    expect(
      requiredSchemaVersion({ briefing: tldr, findings: [{ restored: {} }], hidden: [{}] }),
    ).toBe(SCHEMA_VERSION);
    // Only a list counts; anything else is refused by the parser, not stamped 1.6.
    for (const hidden of [null, "a", 1, {}])
      expect(requiredSchemaVersion({ briefing: tldr, findings: [], hidden }), String(hidden)).toBe(
        TLDR_SCHEMA_VERSION,
      );
  });

  it("the overlay drops a model-supplied hidden list (pipeline-owned) and stamps without it", () => {
    const doc = pr847();
    const { briefing, triage, findings, hidden, graph, provenance } = doc;
    const stamped = expectAccepted(
      applyKnownFields({ briefing, triage, findings, hidden, graph }, provenance),
    );
    expect(stamped.hidden).toBeUndefined();
    expect(stamped.schemaVersion).toBe(TLDR_SCHEMA_VERSION);
  });
});

describe("schema 1.6: hidden", () => {
  it("the fixture carries H1 on the important jobs file, citing the dismissal that hid it", () => {
    const value = expectAccepted(pr847());
    expect(value.schemaVersion).toBe("1.6.0");
    expect(value.hidden?.map((finding) => finding.id)).toEqual(["H1"]);
    expect(value.hidden?.[0]?.hiddenBy).toEqual(HIDDEN_BY);
    // The entry was applied: it is among the memory the analysis applied, quoted identically.
    expect(value.briefing.memoryApplied).toContainEqual(HIDDEN_BY.entry);
    // Hidden findings are not drafts: they count nowhere a draft counts.
    expect(value.findings.some((finding) => finding.id === "H1")).toBe(false);
  });

  it("is optional: 1.5 and older documents without it are accepted unchanged", () => {
    expect(expectAccepted(pr847v15()).hidden).toBeUndefined();
    expect(expectAccepted(pr847v15()).schemaVersion).toBe("1.5.0");
    expect(expectAccepted(pr847v14()).schemaVersion).toBe("1.4.0");
    expect(expectAccepted(pr847WithSummary()).schemaVersion).toBe("1.1.0");
  });

  it("a hidden finding has a draft's fields minus suggestion, memory and restored, plus hiddenBy", () => {
    const hidden = hiddenOf(pr847())!;
    expect(HiddenFinding.safeParse(hidden).success).toBe(true);
    for (const extra of [
      { suggestion: { lines: ["x"] } },
      { memory: [] },
      { restored: pr847().findings.find((f) => f.id === "F3")!.restored },
    ]) {
      expect(HiddenFinding.safeParse({ ...hidden, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
    const withoutHiddenBy: Record<string, unknown> = { ...hidden };
    delete withoutHiddenBy["hiddenBy"];
    expect(HiddenFinding.safeParse(withoutHiddenBy).success).toBe(false);
    for (const bad of [
      { ...HIDDEN_BY, dismissedAs: "model" },
      { ...HIDDEN_BY, path: "../etc/passwd" },
      { ...HIDDEN_BY, shownBecause: "critical_file" },
      { entry: HIDDEN_BY.entry },
    ]) {
      expect(
        HiddenFinding.safeParse({ ...hidden, hiddenBy: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("is held to the location rules of a draft: a known, reviewed file and a range inside a hunk", () => {
    const at = (change: (hidden: NonNullable<ReturnType<typeof hiddenOf>>) => void) => {
      const doc = pr847();
      change(hiddenOf(doc)!);
      return doc;
    };
    expectRejected(
      at((h) => {
        h.path = "src/nowhere.ts";
      }),
      "UNKNOWN_FILE",
      "hidden[0].path",
    );
    expectRejected(
      at((h) => {
        h.path = "pnpm-lock.yaml";
      }),
      "FINDING_IN_NOISE_FILE",
      "hidden[0].path",
    );
    expectRejected(
      at((h) => {
        h.range = { start: 40, end: 40 };
      }),
      "LINE_OUTSIDE_DIFF",
      "hidden[0].range",
    );
    expectRejected(
      at((h) => {
        h.path = "src/api/index.ts";
        h.range = { start: 3, end: 3 };
        h.severity = "critical";
      }),
      "SEVERITY_LEVEL_MISMATCH",
      "hidden[0].severity",
    );
    const doc = pr847();
    doc.provenance.unanalysed = [{ path: JOBS, reason: "timeout" }];
    doc.triage.files = doc.triage.files.filter((f) => f.path !== JOBS);
    doc.findings = doc.findings.filter((f) => f.path !== JOBS);
    doc.briefing.reviewPath = doc.briefing.reviewPath.filter((step) => step.path !== JOBS);
    expectRejected(doc, "FINDING_IN_UNANALYSED_FILE", "hidden[0].path");
  });

  it("the dismissal it cites must be in briefing.memoryApplied, quoted identically", () => {
    const missing = pr847();
    missing.briefing.memoryApplied = missing.briefing.memoryApplied!.filter(
      (ref) => ref.entryId !== "mem-770",
    );
    expectRejected(missing, "MEMORY_REF_MISMATCH", "hidden[0].hiddenBy.entry");
    const reworded = pr847();
    hiddenOf(reworded)!.hiddenBy = {
      ...HIDDEN_BY,
      entry: { ...HIDDEN_BY.entry, text: "Dismissed as intentional: something else" },
    };
    expectRejected(reworded, "MEMORY_REF_MISMATCH", "hidden[0].hiddenBy.entry");
  });

  it("ids are unique within the list; the list is bounded like findings", () => {
    // Fresh copies: the parser refuses a shared subtree before any integrity rule.
    const copy = () => structuredClone(hiddenOf(pr847())!);
    const doc = pr847();
    doc.hidden = [copy(), { ...copy(), range: { start: 3, end: 3 } }];
    expectRejected(doc, "DUPLICATE_ID", "hidden[1].id");
    const many = pr847();
    many.hidden = Array.from({ length: 201 }, (_, i) => ({ ...copy(), id: `H${i + 1}` }));
    expectRejected(many, "INVALID_SHAPE", "hidden");
  });

  it("the published JSON Schema lists `hidden` as optional on the document", () => {
    const schema = AnalysisDocument.toJSONSchema({ io: "input" });
    expect(schema.required).not.toContain("hidden");
    expect(Object.keys(schema.properties ?? {})).toContain("hidden");
  });
});
