import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { type AnalysisDocument, parseAnalysisDocument } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import { mapTargets } from "./targets.js";

const parsed = parseAnalysisDocument(structuredClone(pr847));
if (!parsed.ok) throw new Error("fixture invalid");
const doc: AnalysisDocument = parsed.value;
const targets = mapTargets(doc);

describe("change-map targets (P5-3)", () => {
  it("lists the PR's changed files for the renderer", () => {
    expect(targets.files).toEqual(doc.provenance.files.map((file) => file.path));
  });

  it("opens a card's first file that is in the PR", () => {
    expect(targets.node("page")).toEqual({ kind: "file", path: "web/src/pages/InvitePage.tsx" });
    expect(targets.node("auth")).toEqual({ kind: "file", path: "src/auth/invitations.ts" });
  });

  it("opens nothing for a card outside the PR, without files, or unknown", () => {
    for (const id of ["mem", "mail", "nope", "__proto__", "constructor", "toString", ""])
      expect(targets.node(id), id).toBeUndefined();
  });

  it("never treats a path or a label as a node id", () => {
    expect(targets.node("web/src/pages/InvitePage.tsx")).toBeUndefined();
    expect(targets.node("InvitePage")).toBeUndefined();
  });

  it("opens a badge's first finding at its first line", () => {
    expect(targets.findings("F1 F3 F8")).toEqual({
      kind: "finding",
      path: "src/auth/invitations.ts",
      line: 28,
    });
    expect(targets.findings("F4 F5")).toEqual({
      kind: "finding",
      path: "db/migrations/20261020_add_invitations.sql",
      line: 6,
    });
  });

  it("opens nothing when any id in the list is unknown", () => {
    for (const ids of ["F404", "F1 F404", "F404 F1", "__proto__", "F1  F3", "", " F1"])
      expect(targets.findings(ids), ids).toBeUndefined();
  });

  it("opens nothing for a finding whose file is not in the PR", () => {
    const outside = mapTargets({
      ...doc,
      findings: doc.findings.map((f) => (f.id === "F1" ? { ...f, path: "src/elsewhere.ts" } : f)),
    });
    expect(outside.findings("F1 F3 F8")).toBeUndefined();
    expect(outside.findings("F3")).toEqual({
      kind: "finding",
      path: "src/auth/invitations.ts",
      line: 23,
    });
  });

  it("opens nothing on a document without a graph", () => {
    const withoutGraph: AnalysisDocument = { ...doc };
    delete withoutGraph.graph;
    expect(mapTargets(withoutGraph).node("page")).toBeUndefined();
  });
});
