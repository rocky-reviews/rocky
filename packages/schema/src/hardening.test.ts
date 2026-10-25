/**
 * Regression tests for the independent review of P1 (unicode hiding, size caps, prototype
 * keys, per-file failure state, memory consistency, small rules). Inputs mirror the
 * reviewer's probes.
 */
import { describe, expect, it } from "vitest";
import { Payload } from "./graph.js";
import { MAX_DOCUMENT_BYTES, MAX_FLAGS_TOTAL } from "./limits.js";
import { parseAnalysisDocument, parseAnalysisDocumentJson } from "./parse.js";
import { codeLine, line, pathProblem, prose, RepositoryPath } from "./primitives.js";
import { GitRef, Hunk, hunksInOrder } from "./provenance.js";
import { expectAccepted, expectRejected, pr847 } from "./test-helpers.js";

const BIDI = ["\u202E", "\u202A", "\u202D", "\u2066", "\u2069", "\u200E", "\u200F", "\u061C"];
const HIDING = ["\u200B", "\u2060", "\uFEFF", "\u180E"];
const C1 = ["\u0085", "\u009B", "\u0080", "\u009F"];
const LONE = ["\uD800", "\uDFFF", "a\uD83Db"];

describe("unicode hardening: text", () => {
  const Line = line(50);
  const Prose = prose(50);
  const Code = codeLine(80);

  it("single-line text rejects bidi, hiding, C1, line separators and lone surrogates", () => {
    for (const bad of [...BIDI, ...HIDING, ...C1, "\u2028", "\u2029", ...LONE])
      expect(Line.safeParse(`a${bad}b`).success, JSON.stringify(bad)).toBe(false);
  });

  it("prose rejects bidi, hiding, C1 and lone surrogates but keeps ZWJ/ZWNJ and real text", () => {
    for (const bad of [...BIDI, ...HIDING, ...C1, ...LONE])
      expect(Prose.safeParse(`a${bad}b`).success, JSON.stringify(bad)).toBe(false);
    for (const ok of [
      "👨\u200D👩\u200D👧",
      "نی\u200Cم",
      "a\u2028b",
      "Grüße — naïve café",
      "tab\tnl\n",
    ])
      expect(Prose.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
  });

  it("code lines reject every format character (Trojan Source) and line separators", () => {
    const trojan = "if (isAdmin) { \u202E } \u2066// check later\u2069 { return; }";
    expect(Code.safeParse(trojan).success).toBe(false);
    for (const bad of [...BIDI, ...HIDING, ...C1, "\u00AD", "\u200D", "\u2028", ...LONE])
      expect(Code.safeParse(`x = "${bad}";`).success, JSON.stringify(bad)).toBe(false);
    expect(Code.safeParse("\tconst x = 'ok';").success).toBe(true);
  });

  it("documents with such characters are rejected at the field's path", () => {
    const title = pr847();
    title.findings[0]!.title = "a\u202Eb";
    expectRejected(title, "INVALID_SHAPE", "findings[0].title");
    const summary = pr847();
    summary.briefing.summary = "x\u0085y";
    expectRejected(summary, "INVALID_SHAPE", "briefing.summary");
    const label = pr847();
    label.graph!.lanes[0]!.label = "a\u2028b";
    expectRejected(label, "INVALID_SHAPE", "graph.lanes[0].label");
    const code = pr847();
    code.findings[0]!.suggestion!.lines = ["if (x) { \u202E } \u2066// later\u2069"];
    expectRejected(code, "INVALID_SHAPE", "findings[0].suggestion.lines[0]");
  });
});

describe("unicode hardening: paths", () => {
  it.each([
    "a/\u202Etxt.exe",
    "a/\u200B/b",
    "\uFF0E\uFF0E/etc/passwd",
    "\uFF0E/x",
    "%2e%2e/x",
    "%2E/x",
    "a/%2e%2E/b",
    "a/ /b",
    "a/\u3000/b",
    "a/.../b",
    "a/\u2025/b",
    "a/\u2026/b",
    "a/\u2024\u2024/b",
    "a\u2028b",
    "a/\u0085",
    "a/\uD800",
    "a/\uFEFFb",
    ".git/config",
    "a/.GIT/hooks",
    "e\u0301/x.ts",
    "C:x",
    "c:/x",
    "a//b",
    "a/",
  ])("rejects %j", (path) => {
    expect(RepositoryPath.safeParse(path).success).toBe(false);
    expect(pathProblem(path)).toBeDefined();
  });

  it.each([
    "a b/c d.txt",
    "é/x.ts",
    "a/..b",
    "a/b...",
    "日本語/ファイル.md",
    ".gitignore",
    "a/.github/x",
  ])("accepts %j", (path) => {
    expect(RepositoryPath.safeParse(path).success).toBe(true);
    expect(pathProblem(path)).toBeUndefined();
  });

  it("graph file references use the same path rules", () => {
    const doc = pr847();
    doc.graph!.nodes[0]!.files = [{ path: ".git/hooks/\u202Etxt.sh" }];
    expectRejected(doc, "INVALID_SHAPE", "graph.nodes[0].files[0].path");
  });
});

describe("document size cap", () => {
  it("parseAnalysisDocumentJson accepts the fixture and rejects oversized or malformed text", () => {
    const text = JSON.stringify(pr847());
    expect(parseAnalysisDocumentJson(text).ok).toBe(true);
    const big = parseAnalysisDocumentJson(`${text}${" ".repeat(MAX_DOCUMENT_BYTES)}`);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.code).toBe("LIMIT_EXCEEDED");
    const bad = parseAnalysisDocumentJson("{ not json");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_JSON");
    const notText = parseAnalysisDocumentJson(42 as unknown as string);
    expect(notText.ok).toBe(false);
    if (!notText.ok) expect(notText.error.code).toBe("INVALID_JSON");
  });

  it("measures bytes, not characters", () => {
    const text = `"${"€".repeat(MAX_DOCUMENT_BYTES / 3 + 1)}"`; // under the character count, over the bytes
    expect(text.length).toBeLessThan(MAX_DOCUMENT_BYTES);
    const result = parseAnalysisDocumentJson(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
  });

  it("caps the total number of flags", () => {
    const doc = pr847();
    const flag = { range: { start: 1, end: 1 }, kind: "ok" as const, text: "fine" };
    for (const file of doc.triage.files.slice(0, 6))
      file.flags = Array.from({ length: 50 }, () => flag);
    expect(6 * 50).toBeLessThanOrEqual(MAX_FLAGS_TOTAL);
    expectAccepted(doc);
    for (const file of doc.triage.files) file.flags = Array.from({ length: 50 }, () => flag);
    doc.triage.files = [
      ...doc.triage.files,
      ...Array.from({ length: 40 }, (_, i) => ({
        ...doc.triage.files[6]!,
        path: `extra/${i}.ts`,
      })),
    ];
    for (let i = 0; i < 40; i += 1)
      doc.provenance.files.push({
        path: `extra/${i}.ts`,
        status: "added",
        additions: 1,
        deletions: 0,
        hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }],
      });
    expectRejected(doc, "LIMIT_EXCEEDED", "triage.files");
  });
});

describe("prototype-key safety", () => {
  it("a file named 'constructor' does not break the content lookup", () => {
    const doc = pr847();
    doc.provenance.files.push({
      path: "constructor",
      status: "added",
      additions: 3,
      deletions: 0,
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }],
    });
    doc.triage.files.push({
      path: "constructor",
      score: 50,
      level: "important",
      reason: "r",
      whatChanged: "w",
      whyThisLevel: "y",
      flags: [],
    });
    doc.findings[0] = {
      ...doc.findings[0]!,
      path: "constructor",
      severity: "medium",
      range: { start: 2, end: 2 },
      suggestion: { lines: ["x"], context: "not line one" },
    };
    expectAccepted(doc, { newFileLines: {} });
    expectAccepted(doc, { newFileLines: { toString: ["a"], hasOwnProperty: ["b"] } });
    expectRejected(doc, "SUGGESTION_CONTEXT_MISMATCH", "findings[0].suggestion.context", {
      newFileLines: { constructor: ["one", "two", "three"] },
    } as never);
  });

  it("payload samples reject constructor and prototype keys", () => {
    for (const key of ["constructor", "prototype"]) {
      const sample = JSON.parse(`{"a": {"${key}": {"polluted": true}}}`);
      expect(Payload.safeParse({ request: { type: "T", sample } }).success, key).toBe(false);
    }
  });

  it("an own __proto__ key inside a payload sample is rejected at its path", () => {
    // Zod drops such a key from a record silently; the raw-input inspection reports it instead.
    const text = JSON.stringify(pr847()).replace(
      /"sample":\s*\{/,
      '"sample": {"__proto__": {"polluted": true}, ',
    );
    const doc = JSON.parse(text);
    expectRejected(
      doc,
      "INVALID_SHAPE",
      "graph.flows[0].messages[0].payload.request.sample.__proto__",
    );
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it("own __proto__ / constructor keys anywhere in the document are unknown fields", () => {
    const root = JSON.parse(
      JSON.stringify(pr847()).replace('"schemaVersion"', '"__proto__": {"x":1}, "schemaVersion"'),
    );
    expectRejected(root, "INVALID_SHAPE", "__proto__");
    const nested = JSON.parse(
      JSON.stringify(pr847()).replace('"summary"', '"constructor": {"x":1}, "summary"'),
    );
    expectRejected(nested, "INVALID_SHAPE", "briefing");
  });
});

describe("per-file failure state", () => {
  const unanalyse = (doc = pr847()) => {
    const dropped = doc.triage.files.pop()!;
    doc.triage.unanalysed = [
      { path: dropped.path, reason: "analysis-failed", detail: "Repair failed." },
    ];
    doc.findings = doc.findings.filter((finding) => finding.path !== dropped.path);
    return { doc, dropped };
  };

  it("an unanalysed file counts toward coverage", () => {
    const { doc } = unanalyse();
    const value = expectAccepted(doc);
    expect(value.triage.unanalysed).toHaveLength(1);
  });

  it("must still be a PR file and appear once", () => {
    const { doc } = unanalyse();
    doc.triage.unanalysed![0]!.path = "src/ghost.ts";
    expectRejected(doc, "UNKNOWN_FILE", "triage.unanalysed[0].path");
    const twice = pr847();
    twice.triage.unanalysed = [{ path: twice.triage.files[0]!.path, reason: "binary" }];
    expectRejected(twice, "TRIAGE_COVERAGE", "triage.unanalysed[0].path");
    const alsoNoise = pr847();
    alsoNoise.triage.unanalysed = [{ path: "pnpm-lock.yaml", reason: "too-large" }];
    expectRejected(alsoNoise, "TRIAGE_COVERAGE", "triage.unanalysed[0].path");
  });

  it("carries no finding or review-path step", () => {
    const { doc, dropped } = unanalyse();
    doc.findings.push({
      ...pr847().findings[9]!,
      id: "FX",
      path: dropped.path,
      range: { start: 3, end: 3 },
    });
    expectRejected(doc, "FINDING_IN_UNANALYSED_FILE", `findings[${doc.findings.length - 1}].path`);
    const path = unanalyse().doc;
    path.briefing.reviewPath.push({ path: "src/api/index.ts", why: "x" });
    expectRejected(path, "UNKNOWN_FILE", "briefing.reviewPath[4].path");
  });

  it("rejects unknown reasons", () => {
    const { doc } = unanalyse();
    (doc.triage.unanalysed![0] as { reason: string }).reason = "lazy";
    expectRejected(doc, "INVALID_SHAPE", "triage.unanalysed[0].reason");
  });
});

describe("memory references", () => {
  it("a finding's memory ref must be in briefing.memoryApplied with identical text and source", () => {
    const missing = pr847();
    const f = missing.findings.find((finding) => finding.memory!.length > 0)!;
    f.memory![0]!.entryId = "never-in-briefing";
    expectRejected(
      missing,
      "MEMORY_REF_MISMATCH",
      `findings[${missing.findings.indexOf(f)}].memory[0]`,
    );

    const misquoted = pr847();
    const g = misquoted.findings.find((finding) => finding.memory!.length > 0)!;
    g.memory![0]!.text = "Totally different quote";
    expectRejected(
      misquoted,
      "MEMORY_REF_MISMATCH",
      `findings[${misquoted.findings.indexOf(g)}].memory[0]`,
    );

    const source = pr847();
    const h = source.findings.find((finding) => finding.memory!.length > 0)!;
    h.memory![0]!.source = "elsewhere";
    expectRejected(
      source,
      "MEMORY_REF_MISMATCH",
      `findings[${source.findings.indexOf(h)}].memory[0]`,
    );
  });

  it("briefing may list entries no finding uses", () => {
    const doc = pr847();
    doc.briefing.memoryApplied!.push({ entryId: "mem-extra", text: "Extra", source: "PR #1" });
    expectAccepted(doc);
  });
});

describe("small rules", () => {
  it("ids differing only by case collide", () => {
    const doc = pr847();
    doc.findings[1]!.id = "f1";
    expectRejected(doc, "DUPLICATE_ID", "findings[1].id");
  });

  it("-0 is rejected where 0 is allowed", () => {
    const doc = pr847();
    doc.triage.files[0]!.score = -0;
    expectRejected(doc, "INVALID_SHAPE", "triage.files[0].score");
    const hunk = pr847();
    hunk.provenance.files[0]!.hunks[0]!.oldStart = -0;
    expectRejected(hunk, "INVALID_SHAPE", "provenance.files[0].hunks[0].oldStart");
    expect(Hunk.safeParse({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }).success).toBe(
      true,
    );
  });

  it("hunks must be ordered and non-overlapping on the new side", () => {
    expect(
      hunksInOrder([
        { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4 },
        { oldStart: 18, oldLines: 4, newStart: 19, newLines: 5 },
      ]),
    ).toBe(true);
    expect(
      hunksInOrder([
        { oldStart: 3, oldLines: 3, newStart: 3, newLines: 4 },
        { oldStart: 5, oldLines: 1, newStart: 6, newLines: 1 },
      ]),
    ).toBe(false);
    expect(
      hunksInOrder([
        { oldStart: 10, oldLines: 2, newStart: 9, newLines: 0 },
        { oldStart: 12, oldLines: 1, newStart: 10, newLines: 1 },
      ]),
    ).toBe(true);
    expect(
      hunksInOrder([
        { oldStart: 10, oldLines: 2, newStart: 9, newLines: 0 },
        { oldStart: 12, oldLines: 1, newStart: 9, newLines: 1 },
      ]),
    ).toBe(false);
    const doc = pr847();
    doc.provenance.files[6]!.hunks.reverse();
    expectRejected(doc, "INVALID_SHAPE", "provenance.files[6].hunks");
    const old = pr847();
    old.provenance.files[6]!.hunks[0]!.oldStart = 0;
    expectRejected(old, "INVALID_SHAPE", "provenance.files[6].hunks[0].oldStart");
  });

  it("git refs reject @{, //, trailing .lock, '/' and '.'", () => {
    for (const bad of [
      "a@{b",
      "a//b",
      "feat.lock",
      "feat/",
      "feat.",
      "a b",
      "-x",
      "a..b",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
    ])
      expect(GitRef.safeParse(bad).success, bad).toBe(false);
    for (const ok of ["main", "feat/team-invites", "release-1.2", "user@host", "a.lockfile"])
      expect(GitRef.safeParse(ok).success, ok).toBe(true);
  });

  it("a cycle in the view tree is TOO_DEEP, not a throw", () => {
    const doc = pr847();
    const view: { id: string; title: string; children: unknown[] } = {
      id: "v",
      title: "t",
      children: [],
    };
    view.children.push(view);
    doc.graph!.views = [view as never];
    const result = parseAnalysisDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOO_DEEP");
  });

  it("a shared (DAG) view subtree is rejected by duplicate ids before it can blow up", () => {
    const doc = pr847();
    let leaf: unknown = { id: "leaf", title: "t" };
    for (let i = 0; i < 16; i += 1) leaf = { id: `n${i}`, title: "t", children: [leaf, leaf] };
    doc.graph!.views = [leaf as never];
    const started = Date.now();
    const result = parseAnalysisDocument(doc);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("LIMIT_EXCEEDED");
  });

  it("a 100 000-deep array is TOO_DEEP with the path where nesting became excessive", () => {
    const doc = pr847();
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    doc.graph!.flows![0]!.messages[0]!.payload = { request: { type: "T", sample: deep as never } };
    const result = parseAnalysisDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TOO_DEEP");
      expect(
        result.error.issues[0]!.path.startsWith(
          "graph.flows[0].messages[0].payload.request.sample",
        ),
      ).toBe(true);
    }
  });

  it("a cycle outside the view tree is also TOO_DEEP", () => {
    const doc = pr847() as unknown as Record<string, unknown>;
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    doc.extra = loop;
    const result = parseAnalysisDocument(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOO_DEEP");
  });
});
