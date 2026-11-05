import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { type AnalysisDocument, parseAnalysisDocument } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import {
  briefingBanner,
  briefingLead,
  defaultRiskLevel,
  failureText,
  graphState,
  readByHand,
  type RiskChoice,
  type RiskLevelKey,
  riskLevels,
  selectedRiskLevel,
  shortNames,
  startFile,
  tabKeyTarget,
} from "./briefing-model.js";

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("pr-847 fixture is invalid");
const doc: AnalysisDocument = parsed.value;

describe("riskLevels (H4-10: count chips)", () => {
  const levels = riskLevels(doc);

  it("has critical, important, normal and ignore (low + noise), each with its count", () => {
    expect(levels.map((l) => [l.key, l.label, l.files.length])).toEqual([
      ["critical", "Critical", 3],
      ["important", "Important", 1],
      ["normal", "Normal", 2],
      ["ignore", "Ignore", 3],
    ]);
    expect(levels.every((l) => !("text" in l))).toBe(true);
  });

  it("lists files riskiest first, with low files before noise in the ignore level", () => {
    expect(levels[0]?.files.map((f) => f.path)).toEqual([
      "src/auth/invitations.ts",
      "src/api/routes/invitations.ts",
      "db/migrations/20261020_add_invitations.sql",
    ]);
    expect(levels[3]?.files.map((f) => f.path)).toEqual([
      "src/api/index.ts",
      "pnpm-lock.yaml",
      "src/generated/api-types.ts",
    ]);
  });

  it("shows the parent folder when two file names collide (POC defect 4)", () => {
    const names = levels.flatMap((l) => l.files.map((f) => f.name));
    expect(names).toContain("auth/invitations.ts");
    expect(names).toContain("routes/invitations.ts");
    expect(names).toContain("20261020_add_invitations.sql");
    expect(new Set(names).size).toBe(names.length);
  });

  it("drops levels with no files", () => {
    const onlyNormal: AnalysisDocument = {
      ...doc,
      triage: { files: doc.triage.files.filter((f) => f.level === "normal"), noise: [] },
    };
    expect(riskLevels(onlyNormal).map((l) => l.key)).toEqual(["normal"]);
    expect(riskLevels({ ...doc, triage: { files: [], noise: [] } })).toEqual([]);
  });

  it("adds a Not analysed level, above Ignore, only when the AI could not analyse some files", () => {
    expect(levels.some((l) => l.key === "unanalysed")).toBe(false);
    const withUnanalysed: AnalysisDocument = {
      ...doc,
      provenance: {
        ...doc.provenance,
        unanalysed: [{ path: "src/api/index.ts", reason: "too-large" }],
      },
    };
    expect(riskLevels(withUnanalysed).map((l) => l.key)).toEqual([
      "critical",
      "important",
      "normal",
      "unanalysed",
      "ignore",
    ]);
    const level = riskLevels(withUnanalysed).at(-2);
    expect(level).toMatchObject({ key: "unanalysed", label: "Not analysed" });
    expect(level?.files.map((f) => f.path)).toEqual(["src/api/index.ts"]);
  });
});

describe("defaultRiskLevel", () => {
  const level = (key: RiskLevelKey) => ({ key, label: key, files: [] });

  it("picks the highest-risk level present", () => {
    expect(defaultRiskLevel(riskLevels(doc))).toBe("critical");
    expect(defaultRiskLevel([level("important"), level("normal")])).toBe("important");
    expect(defaultRiskLevel([level("normal"), level("ignore")])).toBe("normal");
    expect(defaultRiskLevel([level("ignore")])).toBe("ignore");
  });

  it("ranks Not analysed below Normal and above Ignore", () => {
    expect(defaultRiskLevel([level("normal"), level("unanalysed")])).toBe("normal");
    expect(defaultRiskLevel([level("unanalysed"), level("ignore")])).toBe("unanalysed");
    expect(defaultRiskLevel([level("unanalysed")])).toBe("unanalysed");
  });

  it("has none when there are no levels", () => {
    expect(defaultRiskLevel([])).toBeUndefined();
  });
});

describe("selectedRiskLevel", () => {
  const levels = riskLevels(doc);
  const head = doc.provenance.head.sha;
  const key = (choice?: RiskChoice, at = head) => selectedRiskLevel(levels, at, choice)?.key;

  it("is the default until the reviewer picks a level", () => {
    expect(key()).toBe("critical");
  });

  it("is the picked level on the document it was picked on", () => {
    expect(key({ head, key: "normal" })).toBe("normal");
  });

  it("resets to the riskiest level when the head commit changes", () => {
    expect(key({ head, key: "normal" }, "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d")).toBe(
      "critical",
    );
  });

  it("falls back to the default when the picked level has no files", () => {
    expect(key({ head, key: "unanalysed" })).toBe("critical");
  });

  it("is none without levels", () => {
    expect(selectedRiskLevel([], head, { head, key: "normal" })).toBeUndefined();
  });
});

describe("tabKeyTarget (WAI-ARIA tabs keys)", () => {
  it("moves right and left, wrapping at the ends", () => {
    expect(tabKeyTarget(4, 0, "ArrowRight")).toBe(1);
    expect(tabKeyTarget(4, 3, "ArrowRight")).toBe(0);
    expect(tabKeyTarget(4, 2, "ArrowLeft")).toBe(1);
    expect(tabKeyTarget(4, 0, "ArrowLeft")).toBe(3);
  });

  it("goes to the first and last tab with Home and End", () => {
    expect(tabKeyTarget(4, 2, "Home")).toBe(0);
    expect(tabKeyTarget(4, 1, "End")).toBe(3);
  });

  it("ignores every other key", () => {
    expect(tabKeyTarget(4, 1, "ArrowDown")).toBeUndefined();
    expect(tabKeyTarget(4, 1, "Enter")).toBeUndefined();
    expect(tabKeyTarget(4, 1, "a")).toBeUndefined();
  });
});

describe("shortNames", () => {
  it("uses the base name, widening only the colliding paths until unique", () => {
    const names = shortNames(["a/x/f.ts", "b/x/f.ts", "c/g.ts", "f.ts"]);
    expect([...names.values()]).toEqual(["a/x/f.ts", "b/x/f.ts", "g.ts", "f.ts"]);
  });
});

describe("startFile", () => {
  it("is the first stop on the path, else the riskiest triaged file", () => {
    expect(startFile(doc)).toBe("src/auth/invitations.ts");
    const noPath = { ...doc, briefing: { ...doc.briefing, reviewPath: [] } };
    expect(startFile(noPath)).toBe("src/auth/invitations.ts");
    const empty = { ...noPath, triage: { files: [], noise: [] } };
    expect(startFile(empty)).toBeUndefined();
  });
});

describe("readByHand", () => {
  it("lists the pipeline's read-by-hand files", () => {
    expect(readByHand(doc)).toEqual([]);
    const marked = {
      ...doc,
      provenance: { ...doc.provenance, readByHand: [{ path: "src/api/index.ts" }] },
    };
    expect(readByHand(marked)).toEqual(["src/api/index.ts"]);
  });
});

describe("briefingLead (H4-8)", () => {
  it("is the TL;DR of a 1.4 document, even next to a summary", () => {
    expect(briefingLead(doc)).toEqual({ kind: "tldr", items: doc.briefing.tldr });
    const both = { ...doc, briefing: { ...doc.briefing, summary: "Old paragraph." } };
    expect(briefingLead(both)).toEqual({ kind: "tldr", items: doc.briefing.tldr });
  });

  it("is the summary paragraph of an older document", () => {
    const briefing = { ...doc.briefing, summary: "Adds invitations." };
    delete briefing.tldr;
    const old = { ...doc, briefing };
    expect(briefingLead(old)).toEqual({ kind: "summary", text: "Adds invitations." });
  });
});

/** The document without its graph, as the pipeline stores it when the map is missing. */
const withoutGraph = (): AnalysisDocument => {
  const copy = { ...doc };
  delete copy.graph;
  return copy;
};

describe("graphState", () => {
  it("is drawn when the document has a graph", () => {
    expect(graphState(doc).kind).toBe("drawn");
  });

  it("gives fixed text for the pipeline's reason, and the pipeline's detail", () => {
    const noGraph = {
      ...withoutGraph(),
      provenance: {
        ...doc.provenance,
        graphUnavailable: { reason: "too-large" as const, detail: "Over the map's file budget." },
      },
    };
    expect(graphState(noGraph)).toEqual({
      kind: "unavailable",
      reason: "This pull request is too large to map.",
      detail: "Over the map's file budget.",
    });
  });

  it("says nothing was mapped, in Rocky's words, when the PR changed no logic (H4-5)", () => {
    const noLogic = {
      ...withoutGraph(),
      provenance: { ...doc.provenance, graphUnavailable: { reason: "no-logic" as const } },
    };
    const state = graphState(noLogic);
    expect(state.kind).toBe("unavailable");
    if (state.kind !== "unavailable") return;
    expect(state.reason).toMatch(/no code|nothing to map/i);
    expect(state.detail).toBeUndefined();
  });

  it("has no reason when the document has no graph and says nothing", () => {
    expect(graphState(withoutGraph())).toEqual({ kind: "unavailable" });
  });
});

describe("failureText", () => {
  it.each([
    ["llm_refused", "The AI provider"],
    ["diff_truncated", "too large"],
    ["diff_unavailable", "diff"],
    ["repository_inaccessible", "can no longer read"],
    ["metering_failed", "usage"],
    ["internal_error", "on Rocky's side"],
    ["something_new", "on Rocky's side"],
  ])("explains %s in plain words", (code, words) => {
    expect(failureText(code)).toContain(words);
  });
});

describe("briefingBanner", () => {
  const old = "9b4e1d7a3c5f2e8b6d0a4c7e1f3b5d9a2c6e8f4b";
  const now = "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d";

  it("is absent for a done run on the current head", () => {
    expect(briefingBanner({ status: "done" }, old, old)).toBeUndefined();
  });

  it("marks a done document of another commit out of date, naming both short SHAs", () => {
    expect(briefingBanner({ status: "done" }, old, now)).toEqual({
      tone: "neutral",
      title: "This briefing is out of date",
      detail:
        "Showing the briefing for an earlier commit, 9b4e1d7; the pull request's head is now 1c2d3e4.",
      live: false,
    });
  });

  it("says a newer run is in progress, as a live status", () => {
    const banner = briefingBanner({ status: "running" }, old, now);
    expect(banner).toMatchObject({
      tone: "ai",
      title: "Re-analysing the latest push…",
      live: true,
    });
    expect(briefingBanner({ status: "queued" }, old, old)?.detail).toBe(
      "Showing the briefing for commit 9b4e1d7.",
    );
  });

  it("says a newer run waits for approval, with the estimate", () => {
    const run = {
      status: "awaiting_approval",
      estimatedTokens: 212_000,
      limitTokens: 150_000,
    } as const;
    expect(briefingBanner(run, old, now)).toMatchObject({
      tone: "warn",
      title: "Waiting for approval to analyse the latest push",
    });
    expect(briefingBanner(run, old, now)?.detail).toContain(
      "about 212,000 tokens, over the per-PR limit of 150,000",
    );
  });

  it("says a newer run failed, with its fixed code", () => {
    expect(briefingBanner({ status: "failed", code: "llm_refused" }, old, now)).toMatchObject({
      tone: "crit",
      title: "The latest push could not be analysed",
      code: "llm_refused",
    });
  });
});
