import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { parseAnalysisDocument } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import { coverage, noiseGroup, sidebarGroups } from "./triage-model.js";

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error(parsed.error.message);
const doc = parsed.value;

describe("sidebarGroups", () => {
  const groups = sidebarGroups(doc);

  it("groups files by risk level in triage order, highest score first", () => {
    expect(groups.map((g) => [g.level, g.files.map((f) => f.score)])).toEqual([
      ["critical", [97, 91, 85]],
      ["important", [61]],
      ["normal", [38, 30]],
      ["low", [12]],
    ]);
  });

  it("lists each file's findings worst first", () => {
    const auth = groups[0]?.files[0];
    expect(auth?.path).toBe("src/auth/invitations.ts");
    expect(auth?.findings.map((f) => f.severity)).toEqual(["critical", "high", "low"]);
    expect(groups[3]?.files[0]?.findings).toEqual([]);
  });

  it("leaves out empty levels", () => {
    const onlyLow = {
      ...doc,
      triage: { ...doc.triage, files: doc.triage.files.filter((f) => f.level === "low") },
    };
    expect(sidebarGroups(onlyLow).map((g) => g.level)).toEqual(["low"]);
  });
});

describe("noiseGroup", () => {
  it("lists the noise files and counts their changed lines", () => {
    const noise = noiseGroup(doc);
    expect(noise.files.map((f) => f.path)).toEqual([
      "pnpm-lock.yaml",
      "src/generated/api-types.ts",
    ]);
    expect(noise.lines).toBe(34 + 3 + 48);
  });
});

describe("coverage", () => {
  const groups = sidebarGroups(doc);

  it("counts critical and important files, with minutes from the analysis (POC defect 6)", () => {
    expect(coverage(groups, new Set())).toEqual({
      reviewed: 0,
      total: 4,
      minutesLeft: 3 + 2 + 1 + 1,
      done: false,
    });
  });

  it("ignores normal and low files", () => {
    const c = coverage(groups, new Set(["web/src/pages/InvitePage.tsx", "src/api/index.ts"]));
    expect(c.reviewed).toBe(0);
  });

  it("shows at least a minute while a high-risk file is left", () => {
    const viewed = new Set(["src/auth/invitations.ts", "src/api/routes/invitations.ts"]);
    viewed.add("db/migrations/20261020_add_invitations.sql");
    const c = coverage(groups, viewed);
    expect(c).toMatchObject({ reviewed: 3, minutesLeft: 1, done: false });
  });

  it("is done when every high-risk file is viewed", () => {
    const all = new Set(groups.slice(0, 2).flatMap((g) => g.files.map((f) => f.path)));
    expect(coverage(groups, all)).toEqual({ reviewed: 4, total: 4, minutesLeft: 0, done: true });
  });
});
