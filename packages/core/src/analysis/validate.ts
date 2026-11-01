/**
 * Validation for the pipeline's units (P4-3, ADR 0014 §5). A stage answer is checked by the same
 * code that checks a stored document: it is placed in a one-file analysis document next to the
 * file's known facts and parsed with `parseAnalysisDocumentJson` (shape, limits, character rules,
 * hunk membership, score bands, suggestion context). No second, weaker set of rules exists.
 *
 * Issues go back to the model in a repair round as `path: CODE` lines, rebased onto the answer's
 * own paths. Messages are never used: they can quote values, and values come from PR content.
 */
import {
  limits,
  parseAnalysisDocumentJson,
  SCHEMA_VERSION,
  type AnalysisDocument,
  type ChangedFile,
  type FileLines,
  type Parsed,
  type Provenance,
  type SchemaIssue,
  type TriagedFile,
  type Walkthrough,
} from "@rocky-reviews/schema";
import type {
  FlowsAnswer,
  GraphAnswer,
  ReviewFinding,
  TriageAnswer,
  WalkthroughAnswer,
} from "./outputs.js";
import { MAX_REPAIR_ISSUES } from "./outputs.js";

/** The facts every unit document shares: the PR and the generator, never a model's word. */
export type ProvenanceBase = Omit<
  Provenance,
  "files" | "unanalysed" | "graphUnavailable" | "briefingUnavailable" | "readByHand"
>;

export interface UnitContext {
  readonly provenance: ProvenanceBase;
  readonly file: ChangedFile;
  readonly newFileLines?: readonly string[] | undefined;
}

/** A briefing no unit check can trip over: the verdict and estimate are at their maximum. */
const UNIT_BRIEFING = {
  summary: "Unit check.",
  verdict: { level: "critical", reason: "Unit check." },
  estimatedReviewMinutes: limits.MAX_REVIEW_MINUTES,
  reviewPath: [],
  checkedOk: [],
  memoryApplied: [],
} as const;

/** `Unrepairable`: an issue outside the answer (a pipeline bug, never the model's to fix). */
export type UnitCheck = readonly string[] | "unrepairable";

const lineOf = (path: string, issue: SchemaIssue): string => `${path || "(root)"}: ${issue.code}`;

/** Rebases issues under `prefix` onto the answer; any other issue makes the check unrepairable. */
const rebase = (
  issues: readonly SchemaIssue[],
  map: (path: string) => string | undefined,
): UnitCheck => {
  const lines: string[] = [];
  for (const issue of issues) {
    const path = map(issue.path);
    if (path === undefined) return "unrepairable";
    lines.push(lineOf(path, issue));
  }
  return lines.slice(0, MAX_REPAIR_ISSUES);
};

export const fileLinesOption = (
  path: string,
  lines: readonly string[] | undefined,
): { newFileLines?: FileLines } =>
  lines === undefined ? {} : { newFileLines: Object.fromEntries([[path, lines]]) };

const unitDocument = (
  context: UnitContext,
  triage: TriagedFile,
  findings: readonly ReviewFinding[],
): Parsed<AnalysisDocument> =>
  parseAnalysisDocumentJson(
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      provenance: { ...context.provenance, files: [context.file], unanalysed: [] },
      briefing: UNIT_BRIEFING,
      triage: { files: [triage], noise: [] },
      findings: findings.map((finding, index) => ({
        ...finding,
        id: `F${index + 1}`,
        path: context.file.path,
        memory: [],
      })),
    }),
    fileLinesOption(context.file.path, context.newFileLines),
  );

const TRIAGE_PREFIX = "triage.files[0]";

/** Checks a triage answer for one file. Issue paths are rebased onto the answer. */
export const checkTriage = (context: UnitContext, answer: TriageAnswer): UnitCheck => {
  const parsed = unitDocument(context, { ...answer, path: context.file.path }, []);
  if (parsed.ok) return [];
  return rebase(parsed.error.issues, (path) => {
    if (path === TRIAGE_PREFIX) return "";
    return path.startsWith(`${TRIAGE_PREFIX}.`) ? path.slice(TRIAGE_PREFIX.length + 1) : undefined;
  });
};

/** Checks a review answer against the file's (already valid) triage entry. */
export const checkReview = (
  context: UnitContext,
  triage: TriagedFile,
  findings: readonly ReviewFinding[],
): UnitCheck => {
  const parsed = unitDocument(context, triage, findings);
  if (parsed.ok) return [];
  // The answer is `{ findings: [...] }`, so a finding's path is the same in both documents.
  return rebase(parsed.error.issues, (path) =>
    path === "findings" || path.startsWith("findings[") ? path : undefined,
  );
};

/** The new-side lines a mapped file's hunks cover: from the first hunk's start to the last's end. */
export interface MappedSpan {
  readonly start: number;
  readonly end: number;
}
export type MappedFiles = ReadonlyMap<string, MappedSpan | undefined>;

export interface StrippedGraph<T> {
  readonly answer: T;
  /** References to files outside the mapped set, dropped. */
  readonly files: number;
  /** Ranges outside the file's changed lines, dropped (the reference stays). */
  readonly ranges: number;
}

/**
 * H4-5: a card or an edge may be backed only by a file the graph call was given (the mapped
 * set, `map-scope.ts`), and a range only where the diff put the component. The published schema
 * lets a file reference name any well-formed path (context nodes, other producers); the pipeline
 * is stricter, so a model can neither map a file Rocky left out nor one it never saw. A stray
 * reference or range is dropped, deterministically, and the map is kept (review round 1, S6):
 * `files` is a list that may be empty and `range` is optional, so the document stays valid, and
 * one stray path is not worth a repair call or a lost map. Paths match exactly, like every path
 * check in the schema. A range is kept when it lies inside the span of the file's new-side hunks
 * (first hunk start to last hunk end): the model only saw the hunks, so it cannot place a
 * component outside them; a file with no new-side lines keeps no range. Only `files[]` is
 * checked: a label, subtitle or summary can still name any file, as any model text can.
 */
/** Drops file references outside the mapped set and ranges outside the file's span, counting both. */
const fileKeeper = (mapped: MappedFiles) => {
  const counts = { files: 0, ranges: 0 };
  const keep = <F extends { readonly path: string; readonly range?: MappedSpan | undefined }>(
    refs: readonly F[],
  ): F[] =>
    refs.flatMap((ref) => {
      if (!mapped.has(ref.path)) {
        counts.files++;
        return [];
      }
      if (ref.range === undefined) return [ref];
      const span = mapped.get(ref.path);
      if (span !== undefined && ref.range.start >= span.start && ref.range.end <= span.end)
        return [ref];
      counts.ranges++;
      const rest: { range?: MappedSpan | undefined } = { ...ref };
      delete rest.range;
      return [rest as F];
    });
  return { keep, counts };
};

export const stripGraphRefs = <T extends GraphAnswer>(
  answer: T,
  mapped: MappedFiles,
): StrippedGraph<T> => {
  const { keep, counts } = fileKeeper(mapped);
  const nodes = answer.nodes.map((node) => ({ ...node, files: keep(node.files) }));
  const edges = answer.edges.map((edge) => ({ ...edge, files: keep(edge.files) }));
  return {
    answer: counts.files === 0 && counts.ranges === 0 ? answer : { ...answer, nodes, edges },
    files: counts.files,
    ranges: counts.ranges,
  };
};

/** The declared ids of a stored map, which a flow or a walkthrough step may reference. */
export interface GraphIds {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
}

export const graphIds = (graph: GraphAnswer): GraphIds => ({
  nodes: new Set(graph.nodes.map((node) => node.id)),
  edges: new Set(graph.edges.map((edge) => edge.id)),
});

export interface StrippedFlows extends StrippedGraph<FlowsAnswer> {
  /** Participants naming an unknown node, messages left without a participant, flows left too small. */
  readonly refs: number;
}

/**
 * H4-7: a flow may only run between nodes the map declares, and a step may only be backed by a
 * mapped file (the same `keep` as the graph's cards). A participant that names an unknown node
 * is dropped, then every message that no longer runs between two participants, then a flow
 * left with fewer participants or messages than the document's minimum; each drop is counted
 * and the rest is kept, like `stripGraphRefs`. What remains still goes through the integrity
 * pass in the whole document (duplicate ids, the self rule), so a model cannot invent an id.
 * An answer with no flow left is returned as such; the caller decides whether that is worth a
 * repair round.
 */
export const stripFlowRefs = (
  answer: FlowsAnswer,
  ids: GraphIds,
  mapped: MappedFiles,
): StrippedFlows => {
  const { keep, counts } = fileKeeper(mapped);
  let refs = 0;
  const flows = answer.flows.flatMap((flow) => {
    const participants = flow.participants.filter((participant) => {
      if (ids.nodes.has(participant.node)) return true;
      refs++;
      return false;
    });
    const present = new Set(participants.map((participant) => participant.node));
    const messages = flow.messages.flatMap((message) => {
      if (!present.has(message.from) || !present.has(message.to)) {
        refs++;
        return [];
      }
      return [{ ...message, files: keep(message.files) }];
    });
    if (
      participants.length < limits.MIN_FLOW_PARTICIPANTS ||
      messages.length < limits.MIN_FLOW_MESSAGES
    ) {
      refs++;
      return [];
    }
    return [{ ...flow, participants, messages }];
  });
  return {
    answer: refs === 0 && counts.files === 0 && counts.ranges === 0 ? answer : { flows },
    refs,
    files: counts.files,
    ranges: counts.ranges,
  };
};

export interface StrippedWalkthrough {
  readonly answer: WalkthroughAnswer;
  /** Focus ids naming no declared node or edge, and steps left with none of their ids. */
  readonly refs: number;
}

/**
 * H4-7: a step's focus may only name nodes and edges the map declares. An unknown id is dropped
 * and counted; a step whose focus named ids and lost every one of them is dropped too (a stop
 * with nothing to light up), while a step the model gave no focus at all keeps meaning "the
 * whole map". The remaining steps are validated in the whole document; fewer than the
 * document's minimum is the caller's to send back.
 */
export const stripWalkthroughRefs = (
  answer: WalkthroughAnswer,
  ids: GraphIds,
): StrippedWalkthrough => {
  let refs = 0;
  const steps = answer.steps.flatMap((step) => {
    const nodes = step.focus.nodes.filter((id) => ids.nodes.has(id));
    const edges = step.focus.edges.filter((id) => ids.edges.has(id));
    const dropped = step.focus.nodes.length - nodes.length + step.focus.edges.length - edges.length;
    refs += dropped;
    const named = step.focus.nodes.length + step.focus.edges.length > 0;
    if (named && nodes.length + edges.length === 0) {
      refs++;
      return [];
    }
    return [dropped === 0 ? step : { ...step, focus: { nodes, edges } }];
  });
  return { answer: refs === 0 ? answer : { steps }, refs };
};

/** The document's shape for a walkthrough answer: an empty focus is the whole map. */
export const toWalkthrough = (answer: WalkthroughAnswer): Walkthrough => ({
  steps: answer.steps.map((step) => ({
    id: step.id,
    heading: step.heading,
    body: step.body,
    focus:
      step.focus.nodes.length + step.focus.edges.length === 0
        ? { kind: "all" }
        : {
            kind: "selection",
            lanes: [],
            nodes: step.focus.nodes,
            edges: step.focus.edges,
            messages: [],
          },
  })),
});

export type DocumentPart = "graph" | "flows" | "walkthrough" | "briefing";

const PIPELINE_OWNED_BRIEFING = ["briefing.estimatedReviewMinutes", "briefing.memoryApplied"];

/** The document path each part's call answers under; issues are rebased onto the answer. */
const PART_PREFIX: Readonly<Record<DocumentPart, string>> = {
  graph: "graph",
  flows: "graph.flows",
  walkthrough: "graph.walkthrough",
  briefing: "briefing",
};
/** Longest prefix first, so a `graph.flows` issue is the flows call's, not the graph's. */
const PARTS_BY_PREFIX = (Object.keys(PART_PREFIX) as DocumentPart[]).sort(
  (a, b) => PART_PREFIX[b].length - PART_PREFIX[a].length,
);

const under = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`);

/**
 * Splits a whole document's issues by the stage that can fix them. `other` holds everything a
 * model cannot repair from here: units were checked one by one, so an issue there means the
 * assembly broke a rule (a pipeline bug, a PR-wide limit) and the analysis fails closed. The
 * flows and the walkthrough are their own parts (H4-7): an issue under `graph.flows` goes back
 * to the flows call as `flows…`, and never to the graph call, which already passed.
 */
export const partitionIssues = (
  issues: readonly SchemaIssue[],
): Readonly<Record<DocumentPart, string[]>> & { readonly other: number } => {
  const parts: Record<DocumentPart, string[]> = {
    graph: [],
    flows: [],
    walkthrough: [],
    briefing: [],
  };
  let other = 0;
  for (const issue of issues) {
    const { path } = issue;
    const owned = PIPELINE_OWNED_BRIEFING.some((prefix) => under(path, prefix));
    const part = owned ? undefined : PARTS_BY_PREFIX.find((p) => under(path, PART_PREFIX[p]));
    if (part === undefined) {
      other++;
      continue;
    }
    const prefix = PART_PREFIX[part];
    // `graph.flows[0].id` → `flows[0].id`; `graph.walkthrough.steps` → `steps`; `graph.nodes` → `nodes`.
    const rest =
      path === prefix
        ? part === "flows"
          ? "flows"
          : ""
        : part === "flows"
          ? path.slice("graph.".length)
          : path.slice(prefix.length + 1);
    if (parts[part].length < MAX_REPAIR_ISSUES) parts[part].push(lineOf(rest, issue));
  }
  return { ...parts, other };
};
