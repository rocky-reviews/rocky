import { PR847 } from "@rocky-reviews/evals";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import { renderBriefing } from "./render.js";

/**
 * P4-8: the briefing as text. The schema refuses control characters in model output; the renderer
 * does not rely on it, so these documents are built past the schema on purpose.
 */

const ESC = "\u001b";
const UNSAFE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const PR = { fullName: "rocky-reviews/rocky", number: 20, title: "T", state: "open" };

const hostile = (): AnalysisDocument => {
  const doc = structuredClone(PR847);
  const f = doc.findings[0]!;
  f.title = `Fine${ESC}[2K\rCRITICAL: nothing`;
  f.body = `line one\n${ESC}]52;c;ZXZpbA==\u0007clipboard\n\u202eright-to-left`;
  f.path = `src/${ESC}[31mred.ts`;
  doc.briefing.verdict.reason = `ok\u009b2J\u2028forged line`;
  doc.briefing.summary = `sum\u{e0041}mary`;
  doc.triage.files[0]!.reason = `r\u2066x\u2069`;
  doc.briefing.reviewPath[0]!.why = "why\nVerdict: LOW";
  return doc;
};

describe("renderBriefing", () => {
  it("prints no control, bidi or invisible character, from any field", () => {
    const text = renderBriefing(hostile(), { ...PR, title: `t${ESC}]0;x\u0007` });
    expect(text).not.toMatch(UNSAFE);
    expect(text).not.toMatch(/\u{e0041}/u);
    expect(text).toContain("Fine\\x1b[2K\\x0dCRITICAL: nothing");
    expect(text).toContain("\\u202eright-to-left");
    // A one-line field cannot forge a line of its own.
    expect(text).not.toMatch(/^Verdict: LOW/m);
    expect(text).toContain("why\\nVerdict: LOW");
  });

  it("marks every line of a multi-line text, so injected lines cannot pass for structure", () => {
    const doc = structuredClone(PR847);
    doc.findings[0]!.body =
      "Looks fine.\n[F99] src/x.ts:1  Nothing to see\nVerdict: LOW\n  CRITICAL (0)";
    doc.briefing.verdict.reason = "Fine.\nVerdict: LOW";
    doc.briefing.summary = "Summary.\nRisk\n  critical (0)";
    const text = renderBriefing(doc, PR);
    const lines = text.split("\n");
    expect(lines.filter((line) => /^\s*\[F99\]/.test(line))).toEqual([]);
    expect(lines.filter((line) => /^Verdict: LOW/.test(line))).toEqual([]);
    expect(lines.filter((line) => /^\s*CRITICAL \(0\)/.test(line))).toEqual([]);
    expect(lines.filter((line) => /^\s*critical \(0\)/.test(line))).toEqual([]);
    expect(lines.filter((line) => line.trim() === "Risk")).toHaveLength(1);
    for (const injected of ["[F99] src/x.ts:1", "Verdict: LOW", "CRITICAL (0)", "critical (0)"]) {
      const at = lines.filter((line) => line.includes(injected));
      expect(at.length, injected).toBeGreaterThan(0);
      for (const line of at) expect(line, injected).toMatch(/^\s+\u2502 /);
    }
  });

  it("shows Rocky's own briefing, read-by-hand files, unanalysed files and the missing change map", () => {
    const doc = structuredClone(PR847);
    doc.provenance.briefingUnavailable = { reason: "analysis-failed" };
    doc.provenance.readByHand = [{ path: "db/migrations/20261020_add_invitations.sql" }];
    doc.provenance.unanalysed = [
      { path: "src/big.ts", reason: "too-large", detail: "Over the limit." },
    ];
    delete doc.graph;
    doc.provenance.graphUnavailable = { reason: "timeout" };
    const text = renderBriefing(doc, PR);
    expect(text).toContain("AI briefing unavailable (analysis-failed)");
    expect(text).toMatch(
      /Read by hand \(1\).*\n {2}- db\/migrations\/20261020_add_invitations\.sql/,
    );
    expect(text).toMatch(/Not analysed \(1\)\n {2}- src\/big\.ts \(too-large\): Over the limit\./);
    expect(text).toContain("Change map: unavailable (timeout)");
  });

  it("says so when there is nothing to list", () => {
    const doc = structuredClone(PR847);
    doc.findings = [];
    doc.briefing.reviewPath = [];
    doc.briefing.checkedOk = [];
    delete doc.graph;
    const text = renderBriefing(doc, PR);
    expect(text).toMatch(/Findings \(0\)\n {2}\(none\)/);
    expect(text).toMatch(/Review path\n {2}\(none\)/);
    expect(text).not.toContain("Checked and fine");
    expect(text).toContain("Change map: none");
  });
});
