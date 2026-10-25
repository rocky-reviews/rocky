/**
 * Property tests (P1-2): random valid documents are accepted; random mutations of them are
 * rejected with the expected code at the expected JSON path. The seed is fixed so CI is
 * deterministic; change it locally to explore.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AnalysisDocument, AnalysisDocumentInput } from "./document.js";
import type { IssueCode } from "./errors.js";
import type { FindingInput, Severity } from "./findings.js";
import type { GraphInput } from "./graph.js";
import { MAX_FILE_REVIEW_MINUTES, MAX_LINE_NUMBER, SCORE_BANDS } from "./limits.js";
import { parseAnalysisDocument } from "./parse.js";
import type { ChangedFile, GraphUnavailableReason } from "./provenance.js";
import type { TriagedFileLevel, TriageInput } from "./triage.js";

const RUNS = { seed: 847, numRuns: 150 };

// --- Raw parameters: independent arbitraries, combined by one deterministic builder --------

const text = (max: number) =>
  fc.stringMatching(new RegExp(`^[A-Za-z0-9][A-Za-z0-9 .,'()-]{0,${max - 1}}$`));
const code = fc.stringMatching(/^[A-Za-z0-9 =();{}.,_-]{0,60}$/);
const nat = fc.nat({ max: 1000 });
const LEVELS: TriagedFileLevel[] = ["critical", "important", "normal", "low"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const GRAPH_UNAVAILABLE_REASONS: GraphUnavailableReason[] = [
  "analysis-failed",
  "too-large",
  "timeout",
];

const arbPath = fc
  .tuple(
    fc.constantFrom("src", "lib", "web", "db"),
    fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/),
    fc.constantFrom("ts", "tsx", "sql", "md"),
  )
  .map(([dir, name, ext]) => `${dir}/${name}.${ext}`);

const arbFile = fc.record({
  path: arbPath,
  status: fc.constantFrom("added", "modified", "renamed") as fc.Arbitrary<ChangedFile["status"]>,
  hunks: fc.array(fc.tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 1, max: 40 }), nat), {
    minLength: 1,
    maxLength: 3,
  }),
});

const arbTriageParams = fc.record({
  level: nat,
  score: nat,
  // 8 files × 60 stays inside MAX_REVIEW_MINUTES, so the PR estimate can always cover the sum.
  minutes: fc.integer({ min: 0, max: 60 }),
  noise: fc.boolean(),
  unanalysed: fc.boolean(),
  flags: fc.array(
    fc.tuple(
      nat,
      nat,
      fc.integer({ min: 0, max: 3 }),
      fc.constantFrom("look", "question", "ok") as fc.Arbitrary<"look" | "question" | "ok">,
    ),
    { maxLength: 2 },
  ),
});

const arbFindingParams = fc.record({
  file: nat,
  hunk: nat,
  offset: nat,
  length: fc.integer({ min: 0, max: 3 }),
  severity: nat,
  confidence: fc.integer({ min: 0, max: 100 }),
  suggestion: fc.option(
    fc.record({ lines: fc.array(code, { maxLength: 3 }), context: fc.boolean() }),
    { nil: undefined },
  ),
  memory: fc.integer({ min: 0, max: 2 }),
  title: text(60),
  body: text(200),
});

const arbGraphParams = fc.record({
  lanes: fc.integer({ min: 1, max: 3 }),
  nodes: fc.array(
    fc.tuple(
      nat,
      fc.constantFrom("module", "route", "datastore", "job", "ui") as fc.Arbitrary<
        "module" | "route" | "datastore" | "job" | "ui"
      >,
    ),
    { minLength: 1, maxLength: 5 },
  ),
  edges: fc.array(fc.tuple(nat, nat, fc.boolean()), { maxLength: 5 }),
  flow: fc.option(
    fc.record({
      participants: fc.integer({ min: 2, max: 3 }),
      messages: fc.array(fc.tuple(nat, nat, nat), { minLength: 1, maxLength: 3 }),
    }),
    { nil: undefined },
  ),
  views: fc.array(
    fc.record({
      selection: fc.option(fc.array(nat, { minLength: 1, maxLength: 3 }), { nil: undefined }),
      children: fc.array(fc.array(nat, { minLength: 1, maxLength: 2 }), { maxLength: 2 }),
    }),
    { maxLength: 2 },
  ),
  walkthrough: fc.option(
    fc.array(
      fc.record({
        focus: fc.option(fc.array(nat, { minLength: 1, maxLength: 3 }), { nil: undefined }),
        onFlow: fc.boolean(),
        messages: fc.array(nat, { minLength: 1, maxLength: 2 }),
      }),
      { minLength: 2, maxLength: 3 },
    ),
    { nil: undefined },
  ),
});

const arbParams = fc.record({
  files: fc.uniqueArray(arbFile, { minLength: 1, maxLength: 8, selector: (file) => file.path }),
  triage: fc.array(arbTriageParams, { minLength: 8, maxLength: 8 }),
  findings: fc.array(arbFindingParams, { maxLength: 6 }),
  verdict: nat,
  minutes: fc.integer({ min: 1, max: 480 }),
  reviewPath: fc.array(nat, { maxLength: 4 }),
  checkedOk: fc.array(text(40), { maxLength: 3 }),
  graph: fc.option(arbGraphParams, { nil: undefined }),
  graphUnavailable: fc.option(fc.constantFrom(...GRAPH_UNAVAILABLE_REASONS), { nil: undefined }),
  summary: text(200),
});

type Params = typeof arbParams extends fc.Arbitrary<infer T> ? T : never;

// --- Builder: turns raw parameters into a document that satisfies every rule ----------------

const buildFiles = (params: Params): ChangedFile[] =>
  params.files.map((file) => {
    let cursor = file.status === "added" ? 1 : 1 + (file.hunks[0]?.[0] ?? 0);
    const hunks = file.hunks.map(([gap, length, oldLines]) => {
      const hunk = {
        oldStart: cursor,
        oldLines: oldLines % (length + 1),
        newStart: cursor,
        newLines: length,
      };
      cursor += length + gap + 1;
      return hunk;
    });
    return {
      path: file.path,
      status: file.status,
      additions: hunks.reduce((sum, hunk) => sum + hunk.newLines, 0),
      deletions: hunks.reduce((sum, hunk) => sum + hunk.oldLines, 0),
      hunks,
    };
  });

const rangeIn = (file: ChangedFile, hunkIndex: number, offset: number, length: number) => {
  const hunk = file.hunks[hunkIndex % file.hunks.length]!;
  const start = hunk.newStart + (offset % hunk.newLines);
  const end = Math.min(start + length, hunk.newStart + hunk.newLines - 1);
  return { start, end };
};

const buildTriage = (params: Params, files: ChangedFile[]): TriageInput => {
  const triage: TriageInput = { files: [], noise: [] };
  files.forEach((file, index) => {
    const p = params.triage[index]!;
    if (p.noise && files.length > 1 && index > 0) {
      triage.noise!.push({ path: file.path, summary: "Generated; trust it." });
      return;
    }
    if (p.unanalysed && files.length > 1 && index > 0) return; // listed in provenance.unanalysed
    const level = LEVELS[p.level % LEVELS.length]!;
    const band = SCORE_BANDS[level];
    triage.files.push({
      path: file.path,
      level,
      score: band.min + (p.score % (band.max - band.min + 1)),
      reviewMinutes: p.minutes,
      reason: "Because.",
      whatChanged: "Something.",
      whyThisLevel: "Area and size.",
      flags: p.flags.map(([hunk, offset, length, kind]) => ({
        range: rangeIn(file, hunk, offset, length),
        kind,
        text: "Look here.",
      })),
    });
  });
  return triage;
};

/** The same quote everywhere: a finding's memory ref must match briefing.memoryApplied exactly. */
const memoryRef = (i: number) => ({ entryId: `mem${i}`, text: `Rule ${i}.`, source: `PR #${i}` });

const buildFindings = (
  params: Params,
  files: ChangedFile[],
  triage: TriageInput,
): FindingInput[] => {
  const triaged = triage.files.map((entry) => files.find((file) => file.path === entry.path)!);
  if (triaged.length === 0) return [];
  return params.findings.map((p, index) => {
    const fileIndex = p.file % triaged.length;
    const file = triaged[fileIndex]!;
    const level = triage.files[fileIndex]!.level;
    const allowed = level === "low" ? SEVERITIES.slice(2) : SEVERITIES;
    const range = rangeIn(file, p.hunk, p.offset, p.length);
    const finding: FindingInput = {
      id: `F${index}`,
      severity: allowed[p.severity % allowed.length]!,
      confidence: p.confidence,
      path: file.path,
      range,
      title: p.title,
      body: p.body,
      memory: Array.from({ length: p.memory }, (_, i) => memoryRef(i)),
      agentPrompt: "Fix it.",
    };
    if (p.suggestion) {
      finding.suggestion = { lines: p.suggestion.lines };
      if (p.suggestion.context && range.start > 1) finding.suggestion.context = "// context";
    }
    return finding;
  });
};

const buildGraph = (params: Params, files: ChangedFile[]): GraphInput | undefined => {
  const g = params.graph;
  if (g === undefined) return undefined;
  const lanes = Array.from({ length: g.lanes }, (_, i) => ({ id: `lane${i}`, label: `Lane ${i}` }));
  const nodes = g.nodes.map(([lane, kind], i) => ({
    id: `n${i}`,
    label: `Node ${i}`,
    kind,
    delta: "modified" as const,
    lane: lanes[lane % lanes.length]!.id,
    files: [{ path: files[i % files.length]!.path }],
  }));
  const edges = g.edges.map(([from, to, hero], i) => ({
    id: `e${i}`,
    from: nodes[from % nodes.length]!.id,
    to: nodes[to % nodes.length]!.id,
    kind: "call" as const,
    delta: "added" as const,
    emphasis: hero ? ("hero" as const) : ("normal" as const),
  }));
  const flows: NonNullable<GraphInput["flows"]> = [];
  if (g.flow && nodes.length >= 2) {
    const participants = nodes
      .slice(0, Math.min(nodes.length, g.flow.participants))
      .map((node) => ({ node: node.id }));
    flows.push({
      id: "flow0",
      title: "Flow",
      participants,
      messages: g.flow.messages.map(([from, to, kind], i) => {
        const source = participants[from % participants.length]!.node;
        const target = participants[to % participants.length]!.node;
        return {
          id: `m${i}`,
          from: source,
          to: target,
          label: `step ${i}`,
          kind:
            source === target
              ? ("self" as const)
              : (["sync", "async", "return"] as const)[kind % 3]!,
          delta: "added" as const,
        };
      }),
    });
  }
  const selectNodes = (indexes: readonly number[]) => [
    ...new Set(indexes.map((i) => nodes[i % nodes.length]!.id)),
  ];
  const views = g.views.map((view, i) => ({
    id: `v${i}`,
    title: `View ${i}`,
    scope: view.selection
      ? ({ kind: "selection", nodes: selectNodes(view.selection) } as const)
      : ({ kind: "all" } as const),
    children: view.children.map((child, j) => ({
      id: `v${i}-${j}`,
      title: "Child",
      scope: { kind: "selection", nodes: selectNodes(child) } as const,
    })),
  }));
  const graph: GraphInput = { lanes, nodes, edges, flows, views };
  if (g.walkthrough) {
    graph.walkthrough = {
      steps: g.walkthrough.map((step, i) => {
        const flow = flows[0];
        const staged = step.onFlow && flow !== undefined;
        const messages = staged
          ? [...new Set(step.messages.map((m) => flow.messages[m % flow.messages.length]!.id))]
          : [];
        const focus = step.focus
          ? ({ kind: "selection", nodes: selectNodes(step.focus), messages } as const)
          : messages.length > 0
            ? ({ kind: "selection", messages } as const)
            : ({ kind: "all" } as const);
        return {
          id: `s${i}`,
          heading: `Step ${i}`,
          body: "One line about it.",
          ...(staged ? { stage: { kind: "flow", flow: flow.id } as const } : {}),
          focus,
        };
      }),
    };
  }
  return graph;
};

const buildDocument = (params: Params): AnalysisDocumentInput => {
  const files = buildFiles(params);
  const triage = buildTriage(params, files);
  const findings = buildFindings(params, files, triage);
  const worst = Math.max(-1, ...findings.map((finding) => RANK[finding.severity]));
  // A critical finding forces a critical verdict; a high one needs at least medium (H2 #5).
  const floor = worst === 3 ? 3 : worst === 2 ? 1 : 0;
  const levels = (["low", "medium", "high", "critical"] as const).slice(floor);
  const triagedPaths = triage.files.map((file) => file.path);
  const fileMinutes = triage.files.reduce((sum, file) => sum + file.reviewMinutes, 0);
  const doc: AnalysisDocumentInput = {
    schemaVersion: "1.0.0",
    provenance: {
      repo: { owner: "acme", name: "rocky-app" },
      pullRequest: { number: 1 },
      base: { sha: "a".repeat(40) },
      head: { sha: "b".repeat(40) },
      files,
      unanalysed: files
        .filter(
          (file, index) =>
            index > 0 &&
            files.length > 1 &&
            params.triage[index]!.unanalysed &&
            !params.triage[index]!.noise,
        )
        .map((file) => ({ path: file.path, reason: "too-large" as const })),
      generatedAt: "2026-10-25T12:00:00.000Z",
      generator: { name: "rocky" },
    },
    briefing: {
      summary: params.summary,
      verdict: { level: levels[params.verdict % levels.length]!, reason: "Because." },
      estimatedReviewMinutes: Math.max(params.minutes, fileMinutes),
      reviewPath: [
        ...new Set(
          params.reviewPath
            .map((i) => triagedPaths[i % Math.max(1, triagedPaths.length)])
            .filter((p): p is string => p !== undefined),
        ),
      ].map((path) => ({ path, why: "Next." })),
      checkedOk: params.checkedOk,
      memoryApplied: Array.from(
        { length: Math.max(0, ...findings.map((finding) => finding.memory?.length ?? 0)) },
        (_, i) => memoryRef(i),
      ),
    },
    triage,
    findings,
  };
  const graph = buildGraph(params, files);
  if (graph) doc.graph = graph;
  else if (params.graphUnavailable !== undefined)
    doc.provenance.graphUnavailable = { reason: params.graphUnavailable, detail: "Pipeline." };
  return doc;
};

const arbDocument = arbParams.map(buildDocument);

// --- Mutations: each breaks one rule and names the code and path it expects -----------------

type Mutation = { code: IssueCode; path: string };
type Mutator = (doc: AnalysisDocument, pick: number) => Mutation | undefined;

const set = (target: object, key: string, value: unknown) =>
  Object.assign(target, { [key]: value });
const lastLine = (file: ChangedFile) =>
  Math.max(0, ...file.hunks.map((hunk) => hunk.newStart + hunk.newLines - 1));

const MUTATORS: Mutator[] = [
  (doc) => (set(doc, "invented", true), { code: "INVALID_SHAPE", path: "" }),
  (doc, pick) => {
    if (doc.triage.files.length === 0) return undefined;
    const i = pick % doc.triage.files.length;
    set(doc.triage.files[i]!, "owner", "x");
    return { code: "INVALID_SHAPE", path: `triage.files[${i}]` };
  },
  (doc) => (
    (doc.briefing.summary = "bad\u0007bell"),
    { code: "INVALID_SHAPE", path: "briefing.summary" }
  ),
  (doc) => (
    (doc.briefing.summary = "cr\r\nlf"),
    { code: "INVALID_SHAPE", path: "briefing.summary" }
  ),
  (doc, pick) => {
    const i = pick % doc.provenance.files.length;
    doc.provenance.files[i]!.path = ["../x", "/etc/passwd", "a\\b", "C:/x", "a/./b", "a//b"][
      pick % 6
    ]!;
    return { code: "INVALID_SHAPE", path: `provenance.files[${i}].path` };
  },
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    doc.findings[i]!.title = "t".repeat(201);
    return { code: "INVALID_SHAPE", path: `findings[${i}].title` };
  },
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    doc.findings[i]!.id = ["bad id", "-x", "", "é", "a<b>"][pick % 5]!;
    return { code: "INVALID_SHAPE", path: `findings[${i}].id` };
  },
  (doc) => (
    (doc.briefing.checkedOk = Array.from({ length: 31 }, () => "ok")),
    { code: "INVALID_SHAPE", path: "briefing.checkedOk" }
  ),
  (doc) => (
    (doc.schemaVersion = "2.0.0"),
    { code: "UNSUPPORTED_SCHEMA_VERSION", path: "schemaVersion" }
  ),
  (doc, pick) => {
    if (doc.findings.length < 2) return undefined;
    const i = 1 + (pick % (doc.findings.length - 1));
    doc.findings[i]!.id = doc.findings[0]!.id;
    return { code: "DUPLICATE_ID", path: `findings[${i}].id` };
  },
  (doc, pick) => {
    if (!doc.graph || doc.graph.edges.length === 0) return undefined;
    const i = pick % doc.graph.edges.length;
    doc.graph.edges[i]!.to = "ghost";
    return { code: "BROKEN_REFERENCE", path: `graph.edges[${i}].to` };
  },
  (doc, pick) => {
    if (!doc.graph) return undefined;
    const i = pick % doc.graph.nodes.length;
    doc.graph.nodes[i]!.lane = "ghost";
    return { code: "BROKEN_REFERENCE", path: `graph.nodes[${i}].lane` };
  },
  (doc) => {
    if (!doc.graph || doc.graph.views.length === 0) return undefined;
    doc.graph.views[0]!.scope = {
      kind: "selection",
      lanes: [],
      nodes: ["ghost"],
      edges: [],
      flows: [],
    };
    return { code: "BROKEN_REFERENCE", path: "graph.views[0].scope.nodes[0]" };
  },
  (doc, pick) => {
    if (!doc.graph || doc.graph.flows.length === 0) return undefined;
    const flow = doc.graph.flows[0]!;
    const i = pick % flow.messages.length;
    flow.messages[i]!.from = "ghost";
    if (flow.messages[i]!.kind === "self") flow.messages[i]!.to = "ghost"; // keep the self rule
    return { code: "BROKEN_REFERENCE", path: `graph.flows[0].messages[${i}].from` };
  },
  (doc, pick) => {
    if (!doc.graph?.walkthrough) return undefined;
    const i = pick % doc.graph.walkthrough.steps.length;
    doc.graph.walkthrough.steps[i]!.stage = { kind: "view", view: "ghost" };
    return { code: "BROKEN_REFERENCE", path: `graph.walkthrough.steps[${i}].stage.view` };
  },
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    doc.findings[i]!.path = "src/planted-by-model.ts";
    return { code: "UNKNOWN_FILE", path: `findings[${i}].path` };
  },
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    const file = doc.provenance.files.find((f) => f.path === doc.findings[i]!.path)!;
    const line = Math.min(lastLine(file) + 1, MAX_LINE_NUMBER);
    doc.findings[i]!.range = { start: line, end: line };
    delete doc.findings[i]!.suggestion;
    return { code: "LINE_OUTSIDE_DIFF", path: `findings[${i}].range` };
  },
  (doc, pick) => {
    const flagged = doc.triage.files
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => file.flags.length > 0);
    if (flagged.length === 0) return undefined;
    const { file, index } = flagged[pick % flagged.length]!;
    const known = doc.provenance.files.find((f) => f.path === file.path)!;
    const line = Math.min(lastLine(known) + 1, MAX_LINE_NUMBER);
    file.flags[0]!.range = { start: line, end: line };
    return { code: "LINE_OUTSIDE_DIFF", path: `triage.files[${index}].flags[0].range` };
  },
  (doc, pick) => {
    if (doc.triage.files.length === 0) return undefined;
    doc.triage.files.splice(pick % doc.triage.files.length, 1);
    return { code: "TRIAGE_COVERAGE", path: "triage" };
  },
  (doc, pick) => {
    if (doc.triage.files.length === 0) return undefined;
    const file = doc.triage.files[pick % doc.triage.files.length]!;
    doc.triage.noise.push({ path: file.path, summary: "Also noise." });
    return { code: "TRIAGE_COVERAGE", path: `triage.noise[${doc.triage.noise.length - 1}].path` };
  },
  (doc, pick) => {
    if (doc.triage.files.length === 0) return undefined;
    const i = pick % doc.triage.files.length;
    const file = doc.triage.files[i]!;
    file.score = file.level === "critical" ? 0 : 100;
    return { code: "SCORE_LEVEL_MISMATCH", path: `triage.files[${i}].score` };
  },
  (doc, pick) => {
    const low = doc.triage.files
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => file.level === "low");
    if (low.length === 0 || doc.findings.length === 0) return undefined;
    const { file } = low[pick % low.length]!;
    const known = doc.provenance.files.find((f) => f.path === file.path)!;
    const i = pick % doc.findings.length;
    const finding = doc.findings[i]!;
    finding.path = file.path;
    finding.range = rangeIn(known, 0, 0, 0);
    finding.severity = "high";
    delete finding.suggestion;
    return { code: "SEVERITY_LEVEL_MISMATCH", path: `findings[${i}].severity` };
  },
  (doc) => {
    if (!doc.findings.some((finding) => RANK[finding.severity] >= 2)) return undefined;
    doc.briefing.verdict.level = "low";
    return { code: "VERDICT_TOO_LOW", path: "briefing.verdict.level" };
  },
  (doc, pick) => {
    if (!doc.findings.some((finding) => finding.severity === "critical")) return undefined;
    doc.briefing.verdict.level = (["high", "medium"] as const)[pick % 2]!;
    return { code: "VERDICT_TOO_LOW", path: "briefing.verdict.level" };
  },
  (doc) => {
    const sum = doc.triage.files.reduce((total, file) => total + file.reviewMinutes, 0);
    if (sum < 2) return undefined; // the estimate's floor is 1, so nothing below the sum exists
    doc.briefing.estimatedReviewMinutes = sum - 1;
    return { code: "REVIEW_MINUTES_TOO_LOW", path: "briefing.estimatedReviewMinutes" };
  },
  (doc, pick) => {
    if (doc.triage.files.length === 0) return undefined;
    const i = pick % doc.triage.files.length;
    set(
      doc.triage.files[i]!,
      "reviewMinutes",
      [-1, MAX_FILE_REVIEW_MINUTES + 1, 2.5, -0, "5"][pick % 5],
    );
    return { code: "INVALID_SHAPE", path: `triage.files[${i}].reviewMinutes` };
  },
  (doc) => {
    if (!doc.graph) return undefined;
    doc.provenance.graphUnavailable = { reason: "timeout" };
    return { code: "INVALID_SHAPE", path: "provenance.graphUnavailable" };
  },
  (doc, pick) => {
    if (doc.graph) return undefined;
    set(doc.provenance, "graphUnavailable", {
      reason: ["failed", "", "Timeout", "<script>"][pick % 4],
    });
    return { code: "INVALID_SHAPE", path: "provenance.graphUnavailable.reason" };
  },
  (doc) => {
    if (doc.triage.files.length === 0) return undefined;
    doc.briefing.reviewPath.push({ path: "src/not-triaged.ts", why: "Because." });
    return {
      code: "UNKNOWN_FILE",
      path: `briefing.reviewPath[${doc.briefing.reviewPath.length - 1}].path`,
    };
  },
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    const finding = doc.findings[i]!;
    const known = doc.provenance.files.find((f) => f.path === finding.path)!;
    if (!known.hunks.some((hunk) => hunk.newStart === 1 && hunk.newLines > 0)) return undefined;
    finding.range = { start: 1, end: 1 };
    finding.suggestion = { lines: ["x"], context: "before" };
    return { code: "SUGGESTION_CONTEXT_IMPOSSIBLE", path: `findings[${i}].suggestion.context` };
  },
  // --- Unicode: bidi, C1, invisible, line separators, lone surrogates ---
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    doc.findings[i]!.title =
      `a${["\u202E", "\u2066", "\u200F", "\u061C", "\u2028", "\u0085", "\u200B", "\uFEFF", "\uD800"][pick % 9]}b`;
    return { code: "INVALID_SHAPE", path: `findings[${i}].title` };
  },
  (doc, pick) => {
    doc.briefing.summary = `x${["\u202A", "\u2069", "\u009B", "\u0085", "\u200B", "\uDFFF", "\u0007"][pick % 7]}y`;
    return { code: "INVALID_SHAPE", path: "briefing.summary" };
  },
  (doc, pick) => {
    const withSuggestion = doc.findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding }) => finding.suggestion);
    if (withSuggestion.length === 0) return undefined;
    const { finding, index } = withSuggestion[pick % withSuggestion.length]!;
    finding.suggestion!.lines = [
      `if (ok) { ${["\u202E", "\u2066", "\u200D", "\u200B", "\uFEFF", "\u00AD", "\u2028"][pick % 7]} } // x`,
    ];
    return { code: "INVALID_SHAPE", path: `findings[${index}].suggestion.lines[0]` };
  },
  (doc, pick) => {
    const i = pick % doc.provenance.files.length;
    doc.provenance.files[i]!.path = [
      "a/\u202Etxt.exe",
      "a/\u200B/b",
      "\uFF0E\uFF0E/etc/passwd",
      "%2e%2e/x",
      "a/ /b",
      "a/.../b",
      "a\u2028b",
      "a/\u0085",
      "a/\uD800",
      "a/\u2025/b",
      "a/%2E/b",
      ".git/config",
      "a/\u06D4\u06D4/b",
      "a/.\u0338/b",
      "a/.git./x",
      "a/git~1/x",
      "a/%252e%252e/b",
      "a/\u3164/b",
      "a/\u2800/b",
      `a/${"\u0301".repeat(7)}x/b`,
      "a/.git:x",
      "a/.git::$INDEX_ALLOCATION/x",
      "a/.%c0%ae/x",
      "a/\u0701\u0701/x",
    ][pick % 24]!;
    return { code: "INVALID_SHAPE", path: `provenance.files[${i}].path` };
  },
  (doc) => {
    if (!doc.graph) return undefined;
    doc.graph.nodes[0]!.files = [{ path: "src/\u202Eevil.ts" }];
    return { code: "INVALID_SHAPE", path: "graph.nodes[0].files[0].path" };
  },
  // --- Codes that previously had unit tests only ---
  (doc, pick) => {
    if (doc.findings.length === 0 || doc.triage.noise.length === 0) return undefined;
    const i = pick % doc.findings.length;
    const noise = doc.triage.noise[pick % doc.triage.noise.length]!;
    const known = doc.provenance.files.find((f) => f.path === noise.path)!;
    doc.findings[i]!.path = noise.path;
    doc.findings[i]!.range = rangeIn(known, 0, 0, 0);
    delete doc.findings[i]!.suggestion;
    return { code: "FINDING_IN_NOISE_FILE", path: `findings[${i}].path` };
  },
  (doc, pick) => {
    if (doc.findings.length === 0 || doc.provenance.unanalysed.length === 0) return undefined;
    const i = pick % doc.findings.length;
    const target = doc.provenance.unanalysed[pick % doc.provenance.unanalysed.length]!;
    const known = doc.provenance.files.find((f) => f.path === target.path)!;
    doc.findings[i]!.path = target.path;
    doc.findings[i]!.range = rangeIn(known, 0, 0, 0);
    delete doc.findings[i]!.suggestion;
    return { code: "FINDING_IN_UNANALYSED_FILE", path: `findings[${i}].path` };
  },
  (doc, pick) => {
    if (doc.triage.files.length < 2) return undefined;
    const i = 1 + (pick % (doc.triage.files.length - 1));
    doc.triage.files[i]!.path = doc.triage.files[0]!.path;
    return { code: "DUPLICATE_PATH", path: `triage.files[${i}].path` };
  },
  (doc) => {
    if (!doc.graph) return undefined;
    doc.graph.views = Array.from({ length: 32 }, (_, i) => ({
      id: `big${i}`,
      title: "v",
      scope: { kind: "all" },
      defaultOpen: false,
      children: Array.from({ length: 2 }, (_, j) => ({
        id: `big${i}-${j}`,
        title: "v",
        scope: { kind: "all" },
        defaultOpen: false,
        children: [],
      })),
    }));
    return { code: "LIMIT_EXCEEDED", path: "graph.views" };
  },
  (doc, pick) => {
    const withMemory = doc.findings
      .map((finding, index) => ({ finding, index }))
      .filter(({ finding }) => finding.memory.length > 0);
    if (withMemory.length === 0) return undefined;
    const { finding, index } = withMemory[pick % withMemory.length]!;
    const ref = finding.memory[0]!;
    if (pick % 2 === 0) ref.text = `${ref.text} (misquoted)`;
    else ref.entryId = "never-applied";
    return { code: "MEMORY_REF_MISMATCH", path: `findings[${index}].memory[0]` };
  },
  (doc, pick) => {
    if (doc.findings.length < 2) return undefined;
    const i = 1 + (pick % (doc.findings.length - 1));
    doc.findings[i]!.id = doc.findings[0]!.id.toUpperCase();
    if (doc.findings[i]!.id === doc.findings[0]!.id)
      doc.findings[i]!.id = doc.findings[0]!.id.toLowerCase();
    return { code: "DUPLICATE_ID", path: `findings[${i}].id` };
  },
  (doc, pick) => {
    const multi = doc.provenance.files
      .map((file, index) => ({ file, index }))
      .filter(({ file }) => file.hunks.length >= 2);
    if (multi.length === 0) return undefined;
    const { file, index } = multi[pick % multi.length]!;
    file.hunks.reverse();
    return { code: "INVALID_SHAPE", path: `provenance.files[${index}].hunks` };
  },
  (doc, pick) => {
    const i = pick % doc.provenance.files.length;
    set(doc.provenance.files[i]!, "additions", -0);
    return { code: "INVALID_SHAPE", path: `provenance.files[${i}].additions` };
  },
  // --- Second review round: default ignorables, blank letters, zalgo, refs, NFC collisions ---
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    const c = [
      "\u{E0049}\u{E0047}",
      "\u00AD",
      "\u2062",
      "\u206A",
      "\uFFF9",
      "\u{E0100}",
      "\u034F",
      "\u3164",
      "\u2800",
      "\u2060",
      "\u180E",
      "\uFFA0",
    ][pick % 12]!;
    doc.findings[i]!.title = `Title${c}x`;
    return { code: "INVALID_SHAPE", path: `findings[${i}].title` };
  },
  (doc, pick) => {
    const c = [
      "\u{E004E}",
      "\u00AD",
      "\u2063",
      "\u206F",
      "\uFFFB",
      "\u{E01EF}",
      "\u034F",
      "\u115F",
      "\u2800",
    ][pick % 9]!;
    doc.briefing.summary = `x${c.repeat(3)}y`;
    return { code: "INVALID_SHAPE", path: "briefing.summary" };
  },
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    const c = [
      "\u{E0049}\u{E0047}\u{E004E}",
      "\u200D",
      "\u200C",
      "\uFE0F",
      "\u00AD",
      "\u2028",
      "\u2800",
      "\u202E",
    ][pick % 8]!;
    doc.findings[i]!.agentPrompt = `Fix it.${c.repeat(2)} ok`;
    return { code: "INVALID_SHAPE", path: `findings[${i}].agentPrompt` };
  },
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    doc.findings[i]!.title = `a${"\u0301".repeat(7 + (pick % 20))}b`;
    return { code: "INVALID_SHAPE", path: `findings[${i}].title` };
  },
  (doc, pick) => {
    doc.provenance.base.ref = [
      "a\u202Eb",
      "a.lock/b",
      ".hidden",
      "a/.b",
      "@",
      "a/b.lock",
      "a\u200Bb",
      "x@{y",
    ][pick % 8]!;
    return { code: "INVALID_SHAPE", path: "provenance.base.ref" };
  },
  (doc) => {
    if (doc.provenance.files.length < 2) return undefined;
    doc.provenance.files[0]!.path = "src/caf\u00E9.ts";
    doc.provenance.files[1]!.path = "src/cafe\u0301.ts";
    return { code: "DUPLICATE_PATH", path: "provenance.files[1].path" };
  },
  // --- Third review round: joiner steganography and interleaved zalgo ---
  (doc, pick) => {
    if (doc.findings.length === 0) return undefined;
    const i = pick % doc.findings.length;
    const bits = "\u200C\u200D".repeat(1 + (pick % 100));
    doc.findings[i]!.title =
      ["Fix", "a\u200D b", "a\u200D", "\u200Da", "x\uFE0F", "a\u200Db\u200Dc\u200Dd"][pick % 6] +
      (pick % 6 === 0 ? bits : "");
    return { code: "INVALID_SHAPE", path: `findings[${i}].title` };
  },
  (doc, pick) => {
    doc.briefing.summary = [
      "Body" + "\u200C\u200D".repeat(50 + (pick % 1000)),
      "x" + "\uFE0F".repeat(3),
      "a" + "\u0301\u0301\u0301\u200D".repeat(10),
    ][pick % 3]!;
    return { code: "INVALID_SHAPE", path: "briefing.summary" };
  },
];

const arbInvalid = fc.tuple(arbDocument, fc.nat(), fc.nat()).map(([input, which, pick]) => {
  const parsed = parseAnalysisDocument(input);
  if (!parsed.ok)
    throw new Error(`generator produced an invalid document:\n${parsed.error.message}`);
  for (let attempt = 0; attempt < MUTATORS.length; attempt += 1) {
    const doc = structuredClone(parsed.value);
    const index = (which + attempt) % MUTATORS.length;
    const expected = MUTATORS[index]!(doc, pick);
    if (expected) return { doc, expected, mutator: index };
  }
  throw new Error("unreachable: the first mutator always applies");
});

// --- Properties ----------------------------------------------------------------------------

describe("property: valid documents", () => {
  it("are accepted, and parsing is idempotent", () => {
    fc.assert(
      fc.property(arbDocument, (doc) => {
        const first = parseAnalysisDocument(doc);
        expect(first.ok, first.ok ? "" : first.error.message).toBe(true);
        if (!first.ok) return;
        const second = parseAnalysisDocument(first.value);
        expect(second.ok).toBe(true);
        if (second.ok) expect(second.value).toEqual(first.value);
      }),
      RUNS,
    );
  });

  it("the generator exercises graphs, flows, walkthroughs, noise, suggestions and findings", () => {
    const seen = {
      graph: 0,
      graphUnavailable: 0,
      flow: 0,
      walkthrough: 0,
      noise: 0,
      suggestion: 0,
      finding: 0,
    };
    fc.assert(
      fc.property(arbDocument, (doc) => {
        if (doc.graph) seen.graph += 1;
        if (doc.provenance.graphUnavailable) seen.graphUnavailable += 1;
        if (doc.graph?.flows?.length) seen.flow += 1;
        if (doc.graph?.walkthrough) seen.walkthrough += 1;
        if (doc.triage.noise?.length) seen.noise += 1;
        if (doc.findings.some((finding) => finding.suggestion)) seen.suggestion += 1;
        if (doc.findings.length > 0) seen.finding += 1;
      }),
      RUNS,
    );
    for (const [feature, count] of Object.entries(seen)) expect(count, feature).toBeGreaterThan(5);
  });
});

describe("property: mutated documents", () => {
  it("are rejected with the expected code at the expected path", () => {
    fc.assert(
      fc.property(arbInvalid, ({ doc, expected, mutator }) => {
        const result = parseAnalysisDocument(doc);
        expect(result.ok, `mutator ${mutator} produced an accepted document`).toBe(false);
        if (result.ok) return;
        const hit = result.error.issues.some(
          (issue) => issue.code === expected.code && issue.path === expected.path,
        );
        expect(
          hit,
          `mutator ${mutator}: expected ${expected.code} at '${expected.path}', got\n${result.error.message}`,
        ).toBe(true);
      }),
      { ...RUNS, numRuns: 400 },
    );
  });

  it("every mutator applies to some generated document", () => {
    // Every mutator is tried on every document, so this does not depend on which mutator
    // `arbInvalid` happens to pick first.
    const used = new Set<number>();
    fc.assert(
      fc.property(arbDocument, fc.nat(), (input, pick) => {
        const parsed = parseAnalysisDocument(input);
        if (!parsed.ok) throw new Error(`generator produced an invalid document`);
        MUTATORS.forEach((mutator, index) => {
          if (mutator(structuredClone(parsed.value), pick) !== undefined) used.add(index);
        });
      }),
      RUNS,
    );
    expect([...used].sort((a, b) => a - b)).toEqual(MUTATORS.map((_, i) => i));
  });
});
