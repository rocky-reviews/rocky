/**
 * Integrity checks: the shape says a field holds an id, a path or a line number; these checks
 * say it points at something that exists. Every issue carries a machine-readable code and the
 * JSON path of the offending value, so the repair round can quote both back to the model.
 *
 * The graph checks are adapted from PR Lens (https://github.com/coldteadotai/pr-lens), MIT
 * License, Copyright (c) 2026 Coldtea AI. See NOTICE.
 *
 * Rules enforced here (each has a code in errors.ts):
 * - ids are unique per collection; paths are unique per collection.
 * - nodes name declared lanes; edges and flow participants name declared nodes; flow messages
 *   name participants of their flow; view scopes and walkthrough stages/focus name declared
 *   elements (messages only on a stage that draws their flow).
 * - the view tree holds at most MAX_VIEWS_TOTAL views and nests at most MAX_VIEW_DEPTH deep.
 * - every PR file is triaged or noise, exactly once; no triage entry names a file outside the
 *   PR; a triage score sits inside its level's band.
 * - findings and flags name triaged (non-noise) PR files and their ranges sit inside one
 *   new-side hunk of that file's diff.
 * - a critical or high finding cannot sit in a file triaged `low`; the verdict cannot be `low`
 *   with a high finding and must be `critical` with a critical finding (gate H2, #5).
 * - the PR's estimated review minutes are at least the sum of the per-file estimates (H2, #9).
 * - review-path steps name triaged files, each once.
 * - a suggestion with a context line cannot start at line 1; when the new file content is
 *   supplied, the context line must match, the range must exist, and the replacement must
 *   differ from the original lines.
 * - files the AI could not analyse (provenance.unanalysed, pipeline-owned) count toward
 *   coverage and carry no triage entry, finding, flag or review-path step.
 * - no two PR file paths are equal under NFC normalisation.
 * - every memory reference on a finding appears in briefing.memoryApplied, quoted identically.
 * - at most MAX_FLAGS_TOTAL flags across the document.
 */
import type { Briefing } from "./briefing.js";
import type { AnalysisDocument } from "./document.js";
import type { SchemaIssue } from "./errors.js";
import type { Finding, MemoryRef, Severity } from "./findings.js";
import type { Flow, Graph, StepStage, View } from "./graph.js";
import { MAX_FLAGS_TOTAL, MAX_VIEW_DEPTH, MAX_VIEWS_TOTAL, SCORE_BANDS } from "./limits.js";
import type { LineRange } from "./primitives.js";
import type { ChangedFile, Hunk } from "./provenance.js";
import type { Triage } from "./triage.js";

/**
 * New-side file contents, by repository path, split into lines (no trailing newline entry).
 * Optional: the pipeline passes what it fetched; checks that need content are skipped for
 * files that are absent.
 */
export type FileLines = Readonly<Record<string, readonly string[]>>;

export type IntegrityOptions = {
  /** New-side (head) contents of changed files, when available. */
  newFileLines?: FileLines | undefined;
};

type Issues = SchemaIssue[];

/** Append without spreading: a spread of a very long array overflows the call stack. */
const append = (issues: Issues, more: readonly SchemaIssue[]): void => {
  for (const issue of more) issues.push(issue);
};

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const RISK_RANK: Record<Briefing["verdict"]["level"], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Indexes of every repeated value after its first occurrence, under a key function. */
const duplicateIndexes = (
  values: readonly string[],
  key: (value: string) => string = (value) => value,
): { index: number; value: string }[] => {
  const seen = new Set<string>();
  const repeated: { index: number; value: string }[] = [];
  values.forEach((value, index) => {
    const k = key(value);
    if (seen.has(k)) repeated.push({ index, value });
    seen.add(k);
  });
  return repeated;
};

/** Ids are compared case-insensitively: anchors and ids often are, so `F1` and `f1` collide. */
const idKey = (id: string): string => id.toLowerCase();

const reportDuplicateIds = (
  issues: Issues,
  collection: string,
  ids: readonly string[],
  field = "id",
): void => {
  for (const { index, value } of duplicateIndexes(ids, idKey))
    issues.push({
      code: "DUPLICATE_ID",
      path: `${collection}[${index}].${field}`,
      message: `duplicate id '${value}' in ${collection} (ids are compared case-insensitively)`,
    });
};

const reportDuplicatePaths = (issues: Issues, collection: string, paths: readonly string[]) => {
  for (const { index, value } of duplicateIndexes(paths))
    issues.push({
      code: "DUPLICATE_PATH",
      path: `${collection}[${index}].path`,
      message: `'${value}' is listed more than once in ${collection}`,
    });
};

// --- Hunks ---------------------------------------------------------------------------------

/** Whether the whole range sits inside one hunk's new side (context lines included). */
export const rangeInsideHunks = (range: LineRange, hunks: readonly Hunk[]): boolean =>
  hunks.some(
    (hunk) =>
      hunk.newLines > 0 &&
      range.start >= hunk.newStart &&
      range.end <= hunk.newStart + hunk.newLines - 1,
  );

// --- Graph ---------------------------------------------------------------------------------

/**
 * Depth-first, with a budget: a shared subtree (a DAG the shape cannot see) would otherwise
 * expand exponentially. Once the budget is spent the tree is over MAX_VIEWS_TOTAL anyway, so
 * the caller reports that and skips the per-view checks.
 */
const flattenViews = (
  views: readonly View[],
  prefix: string,
  depth: number,
  out: { view: View; path: string; depth: number }[],
): void => {
  for (const [index, view] of views.entries()) {
    if (out.length > MAX_VIEWS_TOTAL) return;
    const path = `${prefix}[${index}]`;
    out.push({ view, path, depth });
    flattenViews(view.children, `${path}.children`, depth + 1, out);
  }
};

const messageIdsOf = (flows: readonly Flow[]): Set<string> =>
  new Set(flows.flatMap((flow) => flow.messages.map((message) => message.id)));

/**
 * A flow step is only identified within its own flow, so the stage decides which steps a
 * focus may name. Two flows may each carry a step called `retry`, and neither is wrong.
 */
const stagedMessageIds = (
  stage: StepStage | undefined,
  flows: readonly Flow[],
  viewsById: ReadonlyMap<string, View>,
): ReadonlySet<string> | "no-stage" | "unknown-stage" => {
  if (stage === undefined) return "no-stage";
  if (stage.kind === "flow") {
    const flow = flows.find(({ id }) => id === stage.flow);
    return flow === undefined ? "unknown-stage" : messageIdsOf([flow]);
  }
  const view = viewsById.get(stage.view);
  if (view === undefined) return "unknown-stage";
  if (view.scope.kind === "all") return messageIdsOf(flows);
  const scoped = view.scope.flows;
  return messageIdsOf(flows.filter((flow) => scoped.includes(flow.id)));
};

const graphIssues = (graph: Graph): Issues => {
  const issues: Issues = [];
  const broken = (path: string, message: string) =>
    issues.push({ code: "BROKEN_REFERENCE", path, message });

  const laneIds = new Set(graph.lanes.map((lane) => lane.id));
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const flowIds = new Set(graph.flows.map((flow) => flow.id));

  reportDuplicateIds(
    issues,
    "graph.lanes",
    graph.lanes.map((lane) => lane.id),
  );
  reportDuplicateIds(
    issues,
    "graph.nodes",
    graph.nodes.map((node) => node.id),
  );
  reportDuplicateIds(
    issues,
    "graph.edges",
    graph.edges.map((edge) => edge.id),
  );
  reportDuplicateIds(
    issues,
    "graph.flows",
    graph.flows.map((flow) => flow.id),
  );

  graph.nodes.forEach((node, index) => {
    if (!laneIds.has(node.lane))
      broken(`graph.nodes[${index}].lane`, `node '${node.id}' names unknown lane '${node.lane}'`);
  });

  graph.edges.forEach((edge, index) => {
    if (!nodeIds.has(edge.from))
      broken(`graph.edges[${index}].from`, `edge '${edge.id}' names unknown node '${edge.from}'`);
    if (!nodeIds.has(edge.to))
      broken(`graph.edges[${index}].to`, `edge '${edge.id}' names unknown node '${edge.to}'`);
  });

  graph.flows.forEach((flow, flowIndex) => {
    const at = `graph.flows[${flowIndex}]`;
    const participantIds = new Set(flow.participants.map((participant) => participant.node));

    reportDuplicateIds(
      issues,
      `${at}.participants`,
      flow.participants.map((participant) => participant.node),
      "node",
    );
    reportDuplicateIds(
      issues,
      `${at}.messages`,
      flow.messages.map((message) => message.id),
    );

    flow.participants.forEach((participant, index) => {
      if (!nodeIds.has(participant.node))
        broken(
          `${at}.participants[${index}].node`,
          `flow '${flow.id}' names unknown node '${participant.node}'`,
        );
    });

    flow.messages.forEach((message, index) => {
      for (const end of ["from", "to"] as const) {
        if (!participantIds.has(message[end]))
          broken(
            `${at}.messages[${index}].${end}`,
            `message '${message.id}' names '${message[end]}', which is not a participant of flow '${flow.id}'`,
          );
      }
    });
  });

  const views: { view: View; path: string; depth: number }[] = [];
  flattenViews(graph.views, "graph.views", 1, views);
  if (views.length > MAX_VIEWS_TOTAL) {
    issues.push({
      code: "LIMIT_EXCEEDED",
      path: "graph.views",
      message: `the view tree holds more than ${MAX_VIEWS_TOTAL} views (shared subtrees count every time they appear)`,
    });
    return issues;
  }
  for (const { index, value } of duplicateIndexes(
    views.map(({ view }) => view.id),
    idKey,
  )) {
    const entry = views[index];
    if (entry !== undefined)
      issues.push({
        code: "DUPLICATE_ID",
        path: `${entry.path}.id`,
        message: `duplicate id '${value}' in graph.views`,
      });
  }
  const tooDeep = views.find(({ depth }) => depth > MAX_VIEW_DEPTH);
  if (tooDeep !== undefined)
    issues.push({
      code: "LIMIT_EXCEEDED",
      path: tooDeep.path,
      message: `the view tree nests ${tooDeep.depth} deep; at most ${MAX_VIEW_DEPTH} levels are allowed`,
    });

  for (const { view, path } of views) {
    if (view.scope.kind !== "selection") continue;
    const scope = view.scope;
    const known: [keyof Omit<typeof scope, "kind">, ReadonlySet<string>][] = [
      ["lanes", laneIds],
      ["nodes", nodeIds],
      ["edges", edgeIds],
      ["flows", flowIds],
    ];
    for (const [collection, ids] of known) {
      scope[collection].forEach((id, index) => {
        if (!ids.has(id))
          broken(
            `${path}.scope.${collection}[${index}]`,
            `view '${view.id}' scopes unknown ${collection.slice(0, -1)} '${id}'`,
          );
      });
    }
  }

  if (graph.walkthrough !== undefined) {
    const viewsById = new Map(views.map(({ view }) => [view.id, view] as const));
    const steps = graph.walkthrough.steps;
    reportDuplicateIds(
      issues,
      "graph.walkthrough.steps",
      steps.map((step) => step.id),
    );

    steps.forEach((step, index) => {
      const at = `graph.walkthrough.steps[${index}]`;
      if (step.stage?.kind === "view" && !viewsById.has(step.stage.view))
        broken(`${at}.stage.view`, `step '${step.id}' stages unknown view '${step.stage.view}'`);
      if (step.stage?.kind === "flow" && !flowIds.has(step.stage.flow))
        broken(`${at}.stage.flow`, `step '${step.id}' stages unknown flow '${step.stage.flow}'`);

      if (step.focus.kind !== "selection") return;
      const focus = step.focus;
      const known: [keyof Omit<typeof focus, "kind" | "messages">, ReadonlySet<string>][] = [
        ["lanes", laneIds],
        ["nodes", nodeIds],
        ["edges", edgeIds],
      ];
      for (const [collection, ids] of known) {
        focus[collection].forEach((id, memberIndex) => {
          if (!ids.has(id))
            broken(
              `${at}.focus.${collection}[${memberIndex}]`,
              `step '${step.id}' focuses unknown ${collection.slice(0, -1)} '${id}'`,
            );
        });
      }

      const onStage = stagedMessageIds(step.stage, graph.flows, viewsById);
      if (onStage === "unknown-stage") return; // reported above, once
      if (onStage === "no-stage") {
        if (focus.messages.length > 0)
          broken(
            `${at}.focus.messages`,
            `step '${step.id}' focuses flow steps but names no stage to draw them on`,
          );
        return;
      }
      focus.messages.forEach((id, memberIndex) => {
        if (!onStage.has(id))
          broken(
            `${at}.focus.messages[${memberIndex}]`,
            `step '${step.id}' focuses '${id}', which no flow on its stage carries`,
          );
      });
    });
  }

  return issues;
};

// --- Triage --------------------------------------------------------------------------------

const triageIssues = (
  triage: Triage,
  filesByPath: ReadonlyMap<string, ChangedFile>,
  unanalysed: ReadonlySet<string>,
): Issues => {
  const issues: Issues = [];

  reportDuplicatePaths(
    issues,
    "triage.files",
    triage.files.map((file) => file.path),
  );
  reportDuplicatePaths(
    issues,
    "triage.noise",
    triage.noise.map((file) => file.path),
  );

  const triaged = new Set(triage.files.map((file) => file.path));

  triage.files.forEach((file, index) => {
    const at = `triage.files[${index}]`;
    const known = filesByPath.get(file.path);
    if (known === undefined)
      issues.push({
        code: "UNKNOWN_FILE",
        path: `${at}.path`,
        message: `'${file.path}' is not in the PR's file list`,
      });

    const band = SCORE_BANDS[file.level];
    if (file.score < band.min || file.score > band.max)
      issues.push({
        code: "SCORE_LEVEL_MISMATCH",
        path: `${at}.score`,
        message: `score ${file.score} is outside the '${file.level}' band ${band.min}–${band.max}`,
      });

    file.flags.forEach((flag, flagIndex) => {
      if (known !== undefined && !rangeInsideHunks(flag.range, known.hunks))
        issues.push({
          code: "LINE_OUTSIDE_DIFF",
          path: `${at}.flags[${flagIndex}].range`,
          message: `lines ${flag.range.start}–${flag.range.end} of '${file.path}' are not inside one hunk of the diff`,
        });
    });
  });

  const totalFlags = triage.files.reduce((sum, file) => sum + file.flags.length, 0);
  if (totalFlags > MAX_FLAGS_TOTAL)
    issues.push({
      code: "LIMIT_EXCEEDED",
      path: "triage.files",
      message: `${totalFlags} flags across the document; at most ${MAX_FLAGS_TOTAL} are allowed`,
    });

  const noise = new Set(triage.noise.map((file) => file.path));

  triage.files.forEach((file, index) => {
    if (unanalysed.has(file.path))
      issues.push({
        code: "TRIAGE_COVERAGE",
        path: `triage.files[${index}].path`,
        message: `'${file.path}' could not be analysed (provenance.unanalysed); it cannot also be triaged`,
      });
  });

  triage.noise.forEach((file, index) => {
    if (!filesByPath.has(file.path))
      issues.push({
        code: "UNKNOWN_FILE",
        path: `triage.noise[${index}].path`,
        message: `'${file.path}' is not in the PR's file list`,
      });
    const other = triaged.has(file.path)
      ? "triaged"
      : unanalysed.has(file.path)
        ? "unanalysed"
        : undefined;
    if (other !== undefined)
      issues.push({
        code: "TRIAGE_COVERAGE",
        path: `triage.noise[${index}].path`,
        message: `'${file.path}' is both ${other} and noise`,
      });
  });

  for (const path of filesByPath.keys()) {
    if (!triaged.has(path) && !noise.has(path) && !unanalysed.has(path))
      issues.push({
        code: "TRIAGE_COVERAGE",
        path: "triage",
        message: `'${path}' is in the PR but neither triaged, noise nor unanalysed`,
      });
  }

  return issues;
};

// --- Findings ------------------------------------------------------------------------------

const suggestionIssues = (
  finding: Finding,
  at: string,
  lines: readonly string[] | undefined,
): Issues => {
  const issues: Issues = [];
  const suggestion = finding.suggestion;
  if (suggestion === undefined) return issues;
  const { start, end } = finding.range;

  if (suggestion.context !== undefined && start === 1)
    issues.push({
      code: "SUGGESTION_CONTEXT_IMPOSSIBLE",
      path: `${at}.suggestion.context`,
      message: "a range starting at line 1 has no line before it",
    });

  // Without the file's content nothing more can be checked honestly; see docs/schema.
  if (lines === undefined) return issues;

  if (end > lines.length) {
    issues.push({
      code: "SUGGESTION_RANGE_OUTSIDE_FILE",
      path: `${at}.range.end`,
      message: `'${finding.path}' has ${lines.length} lines; the suggestion ends at ${end}`,
    });
    return issues;
  }

  if (suggestion.context !== undefined && start > 1 && lines[start - 2] !== suggestion.context)
    issues.push({
      code: "SUGGESTION_CONTEXT_MISMATCH",
      path: `${at}.suggestion.context`,
      message: `line ${start - 1} of '${finding.path}' is not the given context line`,
    });

  const original = lines.slice(start - 1, end);
  if (
    original.length === suggestion.lines.length &&
    original.every((text, index) => text === suggestion.lines[index])
  )
    issues.push({
      code: "SUGGESTION_NOOP",
      path: `${at}.suggestion.lines`,
      message: "the suggestion is identical to the lines it replaces",
    });

  return issues;
};

const sameRef = (a: MemoryRef, b: MemoryRef): boolean =>
  a.entryId === b.entryId && a.text === b.text && a.source === b.source;

const findingIssues = (
  findings: readonly Finding[],
  triage: Triage,
  applied: readonly MemoryRef[],
  filesByPath: ReadonlyMap<string, ChangedFile>,
  unanalysed: ReadonlySet<string>,
  fileLines: FileLines | undefined,
): Issues => {
  const issues: Issues = [];
  reportDuplicateIds(
    issues,
    "findings",
    findings.map((finding) => finding.id),
  );

  const levelByPath = new Map(triage.files.map((file) => [file.path, file.level] as const));
  const noise = new Set(triage.noise.map((file) => file.path));
  const appliedById = new Map(applied.map((ref) => [ref.entryId, ref] as const));

  findings.forEach((finding, index) => {
    const at = `findings[${index}]`;
    const known = filesByPath.get(finding.path);

    if (known === undefined)
      issues.push({
        code: "UNKNOWN_FILE",
        path: `${at}.path`,
        message: `'${finding.path}' is not in the PR's file list`,
      });
    else if (noise.has(finding.path))
      issues.push({
        code: "FINDING_IN_NOISE_FILE",
        path: `${at}.path`,
        message: `'${finding.path}' is triaged as noise; a finding there contradicts the triage`,
      });
    else if (unanalysed.has(finding.path))
      issues.push({
        code: "FINDING_IN_UNANALYSED_FILE",
        path: `${at}.path`,
        message: `'${finding.path}' could not be analysed; a finding there cannot be trusted`,
      });

    if (known !== undefined && !rangeInsideHunks(finding.range, known.hunks))
      issues.push({
        code: "LINE_OUTSIDE_DIFF",
        path: `${at}.range`,
        message: `lines ${finding.range.start}–${finding.range.end} of '${finding.path}' are not inside one hunk of the diff`,
      });

    if (levelByPath.get(finding.path) === "low" && SEVERITY_RANK[finding.severity] >= 2)
      issues.push({
        code: "SEVERITY_LEVEL_MISMATCH",
        path: `${at}.severity`,
        message: `a ${finding.severity} finding cannot sit in '${finding.path}', which triage rates 'low'`,
      });

    reportDuplicateIds(
      issues,
      `${at}.memory`,
      finding.memory.map((ref) => ref.entryId),
      "entryId",
    );

    finding.memory.forEach((ref, refIndex) => {
      const known = appliedById.get(ref.entryId);
      if (known === undefined || !sameRef(known, ref))
        issues.push({
          code: "MEMORY_REF_MISMATCH",
          path: `${at}.memory[${refIndex}]`,
          message:
            known === undefined
              ? `memory entry '${ref.entryId}' is not listed in briefing.memoryApplied`
              : `memory entry '${ref.entryId}' is quoted differently from briefing.memoryApplied`,
        });
    });

    // Own-property lookup: a path like "constructor" must not reach Object.prototype.
    const lines =
      fileLines !== undefined && Object.hasOwn(fileLines, finding.path)
        ? fileLines[finding.path]
        : undefined;
    append(issues, suggestionIssues(finding, at, lines));
  });

  return issues;
};

// --- Briefing ------------------------------------------------------------------------------

const briefingIssues = (
  briefing: Briefing,
  triage: Triage,
  findings: readonly Finding[],
): Issues => {
  const issues: Issues = [];
  const triaged = new Set(triage.files.map((file) => file.path));

  reportDuplicatePaths(
    issues,
    "briefing.reviewPath",
    briefing.reviewPath.map((step) => step.path),
  );
  briefing.reviewPath.forEach((step, index) => {
    if (!triaged.has(step.path))
      issues.push({
        code: "UNKNOWN_FILE",
        path: `briefing.reviewPath[${index}].path`,
        message: `'${step.path}' is not a triaged file`,
      });
  });

  reportDuplicateIds(
    issues,
    "briefing.memoryApplied",
    briefing.memoryApplied.map((ref) => ref.entryId),
    "entryId",
  );

  // A critical finding is, by definition, a critical PR: the verdict cannot soften it. Only the
  // severity counts; the document has no accept/dismiss state (those decisions are the human's
  // and live outside it), so nothing a model writes can lower this floor.
  const worst = Math.max(-1, ...findings.map((finding) => SEVERITY_RANK[finding.severity]));
  const verdict = RISK_RANK[briefing.verdict.level];
  const floor =
    worst === SEVERITY_RANK.critical
      ? RISK_RANK.critical
      : worst === SEVERITY_RANK.high
        ? RISK_RANK.medium
        : RISK_RANK.low;
  if (verdict < floor)
    issues.push({
      code: "VERDICT_TOO_LOW",
      path: "briefing.verdict.level",
      message:
        worst === SEVERITY_RANK.critical
          ? `verdict '${briefing.verdict.level}' contradicts a critical finding; a document with a critical finding has verdict 'critical'`
          : `verdict '${briefing.verdict.level}' is too low for a document with high findings; at least 'medium' is required`,
    });

  // The sidebar adds up per-file minutes; the briefing states the PR's. Reading the briefing
  // and the noise takes time too, so the PR estimate may exceed the sum but never fall short.
  const fileMinutes = triage.files.reduce((sum, file) => sum + file.reviewMinutes, 0);
  if (briefing.estimatedReviewMinutes < fileMinutes)
    issues.push({
      code: "REVIEW_MINUTES_TOO_LOW",
      path: "briefing.estimatedReviewMinutes",
      message: `the PR estimate of ${briefing.estimatedReviewMinutes} minutes is below the ${fileMinutes} minutes its triaged files add up to`,
    });

  return issues;
};

// --- Entry point ---------------------------------------------------------------------------

/**
 * Every integrity issue in a shape-valid document. Empty means the document is safe to store,
 * render and show. Order: provenance, graph, triage, findings, briefing.
 */
export const integrityIssues = (
  doc: AnalysisDocument,
  options: IntegrityOptions = {},
): SchemaIssue[] => {
  const issues: Issues = [];

  const paths = doc.provenance.files.map((file) => file.path);
  reportDuplicatePaths(issues, "provenance.files", paths);
  // Two spellings of one name (NFC vs NFD) would be two files to the schema and one to a
  // filesystem; such a PR is refused rather than analysed ambiguously.
  for (const { index, value } of duplicateIndexes(paths, (path) => path.normalize("NFC"))) {
    if (!paths.slice(0, index).includes(value))
      issues.push({
        code: "DUPLICATE_PATH",
        path: `provenance.files[${index}].path`,
        message: `'${value}' equals another listed path under Unicode normalisation`,
      });
  }
  const filesByPath = new Map(doc.provenance.files.map((file) => [file.path, file] as const));

  reportDuplicatePaths(
    issues,
    "provenance.unanalysed",
    doc.provenance.unanalysed.map((file) => file.path),
  );
  doc.provenance.unanalysed.forEach((file, index) => {
    if (!filesByPath.has(file.path))
      issues.push({
        code: "UNKNOWN_FILE",
        path: `provenance.unanalysed[${index}].path`,
        message: `'${file.path}' is not in the PR's file list`,
      });
  });
  const unanalysed = new Set(doc.provenance.unanalysed.map((file) => file.path));

  if (doc.graph !== undefined) append(issues, graphIssues(doc.graph));
  append(issues, triageIssues(doc.triage, filesByPath, unanalysed));
  append(
    issues,
    findingIssues(
      doc.findings,
      doc.triage,
      doc.briefing.memoryApplied,
      filesByPath,
      unanalysed,
      options.newFileLines,
    ),
  );
  append(issues, briefingIssues(doc.briefing, doc.triage, doc.findings));

  return issues;
};
