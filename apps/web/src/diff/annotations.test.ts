import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { type AnalysisDocument, parseAnalysisDocument } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import { fileAnnotations, fileTriage, reviewOrder } from "./annotations.js";

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");
const doc: AnalysisDocument = parsed.value;

describe("fileAnnotations", () => {
  it("places each AI flag under the last line of its range", () => {
    const { flags } = fileAnnotations(doc, "src/auth/invitations.ts");
    expect([...flags.keys()]).toEqual([10, 20, 27]);
    expect(flags.get(20)?.map((f) => f.kind)).toEqual(["look"]);
  });

  it("marks hot lines: a finding's severity wins over a flag's kind", () => {
    const { hot } = fileAnnotations(doc, "src/auth/invitations.ts");
    expect(hot.get(10)).toBe("ok");
    expect(hot.get(20)).toBe("look");
    expect(hot.get(27)).toBe("question");
    // F1 (critical) is on line 28.
    expect(hot.get(28)).toBe("critical");
    expect(hot.get(1)).toBeUndefined();
  });

  it("marks every line of a multi-line range, keeping the worst severity", () => {
    const base = structuredClone(doc);
    const findings = base.findings.filter((f) => f.path === "src/auth/invitations.ts");
    const [first, second] = findings;
    if (!first || !second) throw new Error("fixture changed");
    const edited: AnalysisDocument = {
      ...base,
      findings: [
        { ...first, severity: "medium", range: { start: 11, end: 13 } },
        { ...second, severity: "high", range: { start: 13, end: 14 } },
      ],
      triage: {
        ...base.triage,
        files: base.triage.files.map((f) =>
          f.path === "src/auth/invitations.ts" ? { ...f, flags: [] } : f,
        ),
      },
    };
    const { hot } = fileAnnotations(edited, "src/auth/invitations.ts");
    expect([11, 12, 13, 14].map((n) => hot.get(n))).toEqual(["medium", "medium", "high", "high"]);
  });

  it("is empty for a noise file or a path the analysis does not know", () => {
    for (const path of ["pnpm-lock.yaml", "nope.ts"]) {
      const { hot, flags } = fileAnnotations(doc, path);
      expect(hot.size + flags.size).toBe(0);
    }
  });
});

describe("fileTriage", () => {
  it("describes a triaged file", () => {
    const t = fileTriage(doc, "src/auth/invitations.ts");
    expect(t).toMatchObject({ kind: "triaged", level: "critical", score: 97, findings: 3 });
  });

  it("describes a noise file with its summary", () => {
    const t = fileTriage(doc, "pnpm-lock.yaml");
    expect(t?.kind).toBe("noise");
  });

  it("is null for an unknown path", () => {
    expect(fileTriage(doc, "nope.ts")).toBeNull();
  });
});

describe("reviewOrder", () => {
  it("lists files like the sidebar: by risk level and score, then noise", () => {
    expect(reviewOrder(doc)).toEqual([
      "src/auth/invitations.ts",
      "src/api/routes/invitations.ts",
      "db/migrations/20261020_add_invitations.sql",
      "src/jobs/sendInviteEmail.ts",
      "web/src/pages/InvitePage.tsx",
      "src/auth/invitations.test.ts",
      "src/api/index.ts",
      "pnpm-lock.yaml",
      "src/generated/api-types.ts",
    ]);
  });
});
