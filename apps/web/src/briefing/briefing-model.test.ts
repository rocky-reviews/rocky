import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { type AnalysisDocument, parseAnalysisDocument } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import {
  briefingBanner,
  failureText,
  graphState,
  readByHand,
  reviewPathRows,
  riskRows,
  shortNames,
  startFile,
} from "./briefing-model.js";

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("pr-847 fixture is invalid");
const doc: AnalysisDocument = parsed.value;

describe("riskRows", () => {
  const rows = riskRows(doc);

  it("has the POC's four rows: critical, important, normal and ignore (low + noise)", () => {
    expect(rows.map((r) => [r.key, r.label, r.text])).toEqual([
      ["critical", "Critical", "3 files need your attention"],
      ["important", "Important", "1 file worth a careful look"],
      ["normal", "Normal", "2 files to skim"],
      ["ignore", "Ignore", "3 files don't matter"],
    ]);
  });

  it("lists files riskiest first, with low files before noise in the ignore row", () => {
    expect(rows[0]?.files.map((f) => f.path)).toEqual([
      "src/auth/invitations.ts",
      "src/api/routes/invitations.ts",
      "db/migrations/20261020_add_invitations.sql",
    ]);
    expect(rows[3]?.files.map((f) => f.path)).toEqual([
      "src/api/index.ts",
      "pnpm-lock.yaml",
      "src/generated/api-types.ts",
    ]);
  });

  it("shows the parent folder when two file names collide (POC defect 4)", () => {
    const names = rows.flatMap((r) => r.files.map((f) => f.name));
    expect(names).toContain("auth/invitations.ts");
    expect(names).toContain("routes/invitations.ts");
    expect(names).toContain("20261020_add_invitations.sql");
    expect(new Set(names).size).toBe(names.length);
  });

  it("singularises the critical row", () => {
    const one = { ...doc, triage: { ...doc.triage, files: doc.triage.files.slice(0, 1) } };
    expect(riskRows(one)[0]?.text).toBe("1 file needs your attention");
  });

  it("adds a row for files the AI could not analyse, only when there are some", () => {
    expect(rows.some((r) => r.key === "unanalysed")).toBe(false);
    const withUnanalysed: AnalysisDocument = {
      ...doc,
      provenance: {
        ...doc.provenance,
        unanalysed: [{ path: "src/api/index.ts", reason: "too-large" }],
      },
    };
    const row = riskRows(withUnanalysed).at(-1);
    expect(row).toMatchObject({ key: "unanalysed", label: "Not analysed" });
    expect(row?.text).toBe("1 file the AI couldn't analyse: read it yourself");
  });
});

describe("shortNames", () => {
  it("uses the base name, widening only the colliding paths until unique", () => {
    const names = shortNames(["a/x/f.ts", "b/x/f.ts", "c/g.ts", "f.ts"]);
    expect([...names.values()]).toEqual(["a/x/f.ts", "b/x/f.ts", "g.ts", "f.ts"]);
  });
});

describe("reviewPathRows", () => {
  it("numbers the suggested path with each file's score and level", () => {
    expect(reviewPathRows(doc).slice(0, 2)).toEqual([
      {
        path: "src/auth/invitations.ts",
        why: "New path that grants org membership and sets the member's role.",
        score: 97,
        level: "critical",
      },
      {
        path: "src/api/routes/invitations.ts",
        why: "Public API surface that touches org permissions.",
        score: 91,
        level: "critical",
      },
    ]);
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

describe("riskRows grammar", () => {
  it("says 1 file doesn't matter", () => {
    const one = { ...doc, triage: { ...doc.triage, noise: [] } };
    expect(riskRows(one)[3]?.text).toBe("1 file doesn't matter");
  });
});
