/**
 * Builds the `large-60-files.json` golden fixture: a 60-file PR with findings in many files,
 * a sizeable change map and noise. Deterministic: a seeded generator, no clock, no randomness
 * from the platform, so the committed file is reproducible byte for byte
 * (`pnpm --filter @rocky-reviews/schema fixtures:generate`).
 */
import type { AnalysisDocumentInput } from "../document.js";
import type { FindingInput } from "../findings.js";
import type { GraphInput } from "../graph.js";
import type { Severity } from "../findings.js";
import type { ChangedFile } from "../provenance.js";
import type { TriagedFileLevel } from "../triage.js";

/** mulberry32: small, well-known, good enough for fixtures. */
const seeded = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const AREAS = ["auth", "billing", "orgs", "api", "jobs", "web", "db", "shared"] as const;
const LEVELS: { level: TriagedFileLevel; min: number; max: number }[] = [
  { level: "critical", min: 80, max: 100 },
  { level: "important", min: 50, max: 79 },
  { level: "normal", min: 20, max: 49 },
  { level: "low", min: 0, max: 19 },
];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

export const FILE_COUNT = 60;
export const NOISE_COUNT = 6;
/** Files the pipeline could not analyse; they count toward coverage but carry nothing else. */
export const UNANALYSED_COUNT = 2;

export const buildLargeFixture = (): AnalysisDocumentInput => {
  const random = seeded(847);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const int = (min: number, max: number): number => min + Math.floor(random() * (max - min + 1));

  const files: ChangedFile[] = [];
  for (let index = 0; index < FILE_COUNT; index += 1) {
    const area = AREAS[index % AREAS.length] as (typeof AREAS)[number];
    const isNoise = index >= FILE_COUNT - NOISE_COUNT;
    const isUnanalysed = !isNoise && index >= FILE_COUNT - NOISE_COUNT - UNANALYSED_COUNT;
    const path = isNoise
      ? `generated/${area}/types-${index}.ts`
      : isUnanalysed
        ? `vendor/${area}/bundle-${index}.min.js`
        : `src/${area}/module-${String(index).padStart(2, "0")}.ts`;
    const status = index % 7 === 0 ? "added" : "modified";
    const hunkCount = status === "added" ? 1 : int(1, 3);
    const hunks = [];
    let cursor = status === "added" ? 1 : int(1, 40);
    for (let h = 0; h < hunkCount; h += 1) {
      const newLines = int(8, 60);
      hunks.push({
        oldStart: status === "added" ? 0 : cursor,
        oldLines: status === "added" ? 0 : int(3, newLines),
        newStart: cursor,
        newLines,
      });
      cursor += newLines + int(5, 30);
    }
    const additions = hunks.reduce((sum, hunk) => sum + hunk.newLines, 0);
    const deletions = hunks.reduce((sum, hunk) => sum + hunk.oldLines, 0);
    files.push({ path, status, additions, deletions, hunks });
  }

  const triagedFiles = files.slice(0, FILE_COUNT - NOISE_COUNT - UNANALYSED_COUNT);
  const unanalysedFiles = files.slice(
    FILE_COUNT - NOISE_COUNT - UNANALYSED_COUNT,
    FILE_COUNT - NOISE_COUNT,
  );
  const noiseFiles = files.slice(FILE_COUNT - NOISE_COUNT);

  const triage = triagedFiles.map((file, index) => {
    const band = LEVELS[Math.min(3, Math.floor(index / 15))] as (typeof LEVELS)[number];
    const hunk = file.hunks[0] as (typeof file.hunks)[number];
    const flagLine = hunk.newStart + int(0, hunk.newLines - 1);
    return {
      path: file.path,
      score: int(band.min, band.max),
      level: band.level,
      reason: `Touches the ${file.path.split("/")[1] ?? "shared"} area (${file.additions} lines).`,
      whatChanged: `Reworks module ${index} to use the new shared client.`,
      whyThisLevel: `Rated ${band.level} because of the area it sits in and the size of the change.`,
      flags:
        index % 4 === 0
          ? [
              {
                range: { start: flagLine, end: flagLine },
                kind: pick(["look", "question", "ok"] as const),
                text: `Line ${flagLine} is where module ${index} changes behaviour.`,
              },
            ]
          : [],
    };
  });

  const findings: FindingInput[] = [];
  triagedFiles.forEach((file, index) => {
    if (index % 3 !== 0) return;
    const level = triage[index]?.level ?? "normal";
    const allowed = level === "low" ? SEVERITIES.slice(2) : SEVERITIES;
    const severity = pick(allowed);
    const hunk = file.hunks[file.hunks.length - 1] as (typeof file.hunks)[number];
    const start = hunk.newStart + int(0, Math.max(0, hunk.newLines - 3));
    const end = Math.min(start + int(0, 2), hunk.newStart + hunk.newLines - 1);
    findings.push({
      id: `F${findings.length + 1}`,
      severity,
      confidence: int(50, 99),
      path: file.path,
      range: { start, end },
      title: `Module ${index}: ${severity} issue in the new client call`,
      body: `The call at lines ${start}–${end} of \`${file.path}\` ignores the error branch of the shared client. See \`shared/client.ts\` for the contract.`,
      suggestion:
        index % 2 === 0
          ? {
              lines: [`  const result = await client.call(input); // module ${index}`],
              context: start > 1 ? `  // module ${index}: before the call` : undefined,
            }
          : undefined,
      memory:
        index % 6 === 0
          ? [
              {
                entryId: "mem-1",
                text: "Shared client errors must be handled",
                source: "decision · PR #700",
              },
            ]
          : [],
      agentPrompt: `In ${file.path}, handle the error branch of client.call at lines ${start}–${end} and add a test for it.`,
    });
  });

  const lanes = AREAS.map((area, index) => ({
    id: `lane-${area}`,
    label: area.toUpperCase(),
    order: index,
  }));
  const nodes = triagedFiles.map((file, index) => ({
    id: `n${index}`,
    label: `module-${String(index).padStart(2, "0")}`,
    kind: pick(["module", "function", "route", "job", "datastore", "ui"] as const),
    delta: file.status === "added" ? ("added" as const) : ("modified" as const),
    lane: `lane-${file.path.split("/")[1] ?? "shared"}`,
    files: [{ path: file.path }],
  }));
  nodes.push({
    id: "n-db",
    label: "postgres",
    kind: "datastore",
    delta: "modified",
    lane: "lane-db",
    files: [],
  });
  const edges = nodes.slice(0, -1).map((node, index) => ({
    id: `e${index}`,
    from: node.id,
    to:
      index % 5 === 0
        ? "n-db"
        : (nodes[(index + 7) % (nodes.length - 1)] as (typeof nodes)[number]).id,
    kind: pick(["call", "http", "data", "queue"] as const),
    delta: "modified" as const,
    emphasis: index === 3 ? ("hero" as const) : ("normal" as const),
  }));

  const graph: GraphInput = {
    lanes,
    nodes,
    edges: edges.filter((edge) => edge.from !== edge.to),
    flows: [
      {
        id: "flow-main",
        title: "Request through the shared client",
        participants: [{ node: "n0" }, { node: "n7" }, { node: "n-db" }],
        messages: [
          { id: "m1", from: "n0", to: "n7", label: "call()", delta: "modified" },
          { id: "m2", from: "n7", to: "n-db", label: "SELECT", delta: "modified" },
          { id: "m3", from: "n-db", to: "n7", label: "rows", kind: "return", delta: "unchanged" },
        ],
      },
    ],
    views: [
      {
        id: "all",
        title: "Everything",
        defaultOpen: true,
        children: AREAS.map((area) => ({
          id: `view-${area}`,
          title: `${area} lane`,
          scope: { kind: "selection", lanes: [`lane-${area}`] },
        })),
      },
    ],
    walkthrough: {
      steps: [
        {
          id: "s1",
          heading: "The shared client",
          body: "Every module now calls one client.",
          focus: { kind: "selection", nodes: ["n0", "n7"] },
        },
        {
          id: "s2",
          heading: "Where it hits the database",
          body: "Only the db lane talks to postgres.",
          stage: { kind: "flow", flow: "flow-main" },
          focus: { kind: "selection", messages: ["m2"] },
        },
        {
          id: "s3",
          heading: "Generated types",
          body: "Six generated files follow; trust them.",
          focus: { kind: "all" },
        },
      ],
    },
  };

  return {
    schemaVersion: "1.0.0",
    provenance: {
      repo: { owner: "acme", name: "rocky-app" },
      pullRequest: { number: 1200 },
      base: { sha: "a".repeat(40), ref: "main" },
      head: { sha: "b".repeat(40), ref: "refactor/shared-client" },
      files,
      generatedAt: "2026-10-25T12:00:00.000Z",
      generator: { name: "rocky", version: "0.0.0", roles: [{ role: "review", model: "fixture" }] },
    },
    briefing: {
      summary: "Moves every module onto the shared client and regenerates the API types.",
      verdict: {
        level: "critical",
        reason: "Sixty files across auth, billing and orgs; several modules drop error handling.",
      },
      estimatedReviewMinutes: 95,
      reviewPath: triage.slice(0, 20).map((file) => ({ path: file.path, why: file.reason })),
      checkedOk: ["Generated files match the OpenAPI spec", "No new dependencies"],
      memoryApplied: [
        {
          entryId: "mem-1",
          text: "Shared client errors must be handled",
          source: "decision · PR #700",
        },
      ],
    },
    triage: {
      files: triage,
      noise: noiseFiles.map((file) => ({
        path: file.path,
        summary: "Regenerated from the OpenAPI spec; no hand edits.",
      })),
      unanalysed: unanalysedFiles.map((file) => ({
        path: file.path,
        reason: "too-large" as const,
        detail: "Minified bundle over the per-file token budget.",
      })),
    },
    findings,
    graph,
  };
};
