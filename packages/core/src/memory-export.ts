import {
  limits,
  pathProblem,
  RepoName,
  RepoOwner,
  textProblem,
  type Severity,
} from "@rocky-reviews/schema";
import { containsPromptCanaryFragment } from "./analysis/leak.js";
import { isDismissReason, type DismissReason } from "./drafts.js";
import { MEMORY_KINDS, type MemoryEvidence, type MemoryKind, type MemoryOrigin } from "./memory.js";

/**
 * The export of a repository's project memory to `.rocky/context.md` (P8-3, ADR 0039): a
 * markdown file the person downloads and commits themselves. Rocky never writes it to a disk or
 * to the repository.
 *
 * What goes in: each current entry's kind, text, dismissal reason and the severity it covers,
 * evidence (path, commit, lines, source PR), confidence, origin and whether it is switched off.
 * What never goes in: who taught it (a login committed to git cannot be erased when the person
 * leaves; entries store a member id only, ADR 0036 §3), entry ids, timestamps (they would
 * change the file on every review that cites an entry), and any entry whose text or path holds
 * a fragment of a prompt canary (none should: the store refuses them; this is the second check).
 *
 * Entry text and paths are untrusted data (they come from pull requests). They are written as
 * literal text: every character markdown could read as syntax (`\`, backticks, emphasis, links,
 * HTML, headings, tables, strikethrough, entities, math) is backslash-escaped, and so is a
 * leading list or heading marker, so an entry can never become a heading, a link, HTML or a
 * second list item. `parseMemoryContext` reads the file back to the same entries: the export
 * round-trips (`memory-export.test.ts`).
 */

export const MEMORY_EXPORT_FILENAME = "context.md";
/** Where the file is meant to be committed. */
export const MEMORY_EXPORT_REPO_PATH = ".rocky/context.md";
export const MEMORY_EXPORT_FORMAT_LINE = "Format: rocky-memory-export 1";

export interface MemoryExportEntry {
  readonly kind: MemoryKind;
  readonly origin: MemoryOrigin;
  readonly text: string;
  readonly reason: DismissReason | null;
  /** A dismissal's covered severity (`MemoryEntry.severity`), or `null`. */
  readonly severity: Severity | null;
  readonly evidence: MemoryEvidence;
  readonly confidence: number;
  /** Switched off in Rocky (P8-3): kept, never offered to a review. */
  readonly disabled: boolean;
}

const SECTION: Readonly<Record<MemoryKind, string>> = {
  convention: "Conventions",
  decision: "Decisions",
  dismissal: "Dismissals",
};
const REASON_LABEL: Readonly<Record<DismissReason, string>> = {
  not_an_issue: "not an issue",
  intentional: "intentional",
  not_worth_it: "not worth it",
  handled_elsewhere: "handled elsewhere",
};
const ORIGIN_LABEL: Readonly<Record<MemoryOrigin, string>> = {
  learned: "learned from a review",
  member: "written by a member",
};
const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Markdown syntax characters in inline text (CommonMark, GFM tables, strikethrough and math). */
const INLINE_SYNTAX = /[\\`*_[\]<>#|~&!$]/gu;
/**
 * GitHub's autolink extension makes links of bare `scheme://…`, `www.…` and `name@host…` text:
 * the `:` before `//`, the `.` after `www` and every `@` are escaped, so none of them links.
 */
const AUTOLINK = /:(?=\/)|(?<=www)\.|@/giu;

/**
 * Untrusted text as literal markdown inside a line: every syntax character escaped, what an
 * autolink starts with, and a leading block marker (`-`, `+`, `=`, `1.`, `1)`) too, since the text
 * starts a list item.
 */
export const escapeMarkdownText = (text: string): string =>
  text
    .replace(INLINE_SYNTAX, (c) => `\\${c}`)
    // After the syntax pass, so the backslashes added here are not escaped again.
    .replace(AUTOLINK, (c) => `\\${c}`)
    .replace(/^([-+=])/u, "\\$1")
    .replace(/^(\d{1,9})([.)])/u, "$1\\$2");

/** The inverse of `escapeMarkdownText` (any backslash-escaped ASCII punctuation). */
export const unescapeMarkdownText = (text: string): string =>
  text.replace(/\\([!-/:-@[-`{-~])/gu, "$1");

/** Whether an entry may be exported: the store's text and path rules, checked again. */
const exportable = (entry: MemoryExportEntry): boolean =>
  entry.text.length >= 1 &&
  entry.text.length <= limits.MAX_MEMORY_TEXT_LENGTH &&
  entry.text.trim() === entry.text &&
  textProblem(entry.text, "line") === undefined &&
  !containsPromptCanaryFragment(entry.text) &&
  entry.evidence.path.length <= limits.MAX_PATH_LENGTH &&
  pathProblem(entry.evidence.path) === undefined &&
  !containsPromptCanaryFragment(entry.evidence.path) &&
  FULL_SHA.test(entry.evidence.sha) &&
  (entry.kind === "dismissal") === (entry.reason !== null) &&
  (entry.severity === null || entry.kind === "dismissal");

const linesOf = (range: MemoryEvidence["range"]): string =>
  range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;

const entryLines = (entry: MemoryExportEntry): string[] => {
  const lines = [`- ${escapeMarkdownText(entry.text)}`];
  if (entry.reason !== null) {
    const covers = entry.severity === null ? "" : `, covers findings up to ${entry.severity}`;
    lines.push(`  - Reason: ${REASON_LABEL[entry.reason]}${covers}`);
  }
  const { path, range, sha, pullRequestNumber } = entry.evidence;
  lines.push(
    `  - Evidence: ${escapeMarkdownText(path)}, ${linesOf(range)}, commit ${sha}, PR #${pullRequestNumber}`,
    `  - Confidence: ${entry.confidence} · ${ORIGIN_LABEL[entry.origin]}${entry.disabled ? " · switched off" : ""}`,
  );
  return lines;
};

export interface RenderedMemoryContext {
  readonly markdown: string;
  readonly exported: number;
  /** Entries left out because they failed the export's checks (a count, never which). */
  readonly dropped: number;
}

/**
 * The `context.md` for `repository` (`owner/name`) with `entries`, grouped by kind
 * (conventions, decisions, dismissals), each group in the order given.
 */
export const renderMemoryContext = (input: {
  readonly repository: string;
  readonly entries: readonly MemoryExportEntry[];
}): RenderedMemoryContext => {
  const kept = input.entries.filter(exportable);
  const out = [`# Project memory: ${escapeMarkdownText(input.repository)}`, ...PREAMBLE];
  if (kept.length === 0) out.push("", "No entries.");
  for (const kind of MEMORY_KINDS) {
    const group = kept.filter((e) => e.kind === kind);
    if (group.length === 0) continue;
    out.push("", `## ${SECTION[kind]}`, "");
    for (const entry of group) out.push(...entryLines(entry));
  }
  return {
    markdown: `${out.join("\n")}\n`,
    exported: kept.length,
    dropped: input.entries.length - kept.length,
  };
};

/** The order `renderMemoryContext` writes entries in (what a parse gives back). */
export const exportOrder = (entries: readonly MemoryExportEntry[]): MemoryExportEntry[] =>
  MEMORY_KINDS.flatMap((kind) => entries.filter((e) => e.kind === kind));

/** The fixed lines between the heading and the entries (the parser compares them exactly). */
const PREAMBLE: readonly string[] = [
  "",
  "What the reviewers of this repository decided, as Rocky Reviews keeps it. Rocky quotes these",
  "entries to its reviews as data, never as instructions. Entries are edited in Rocky (the",
  "repository's memory page); export again to update this file.",
  "",
  MEMORY_EXPORT_FORMAT_LINE,
];

/** `owner/name` by GitHub's rules. */
const isRepository = (value: string): boolean => {
  const [owner, name, extra] = value.split("/");
  return (
    extra === undefined &&
    RepoOwner.safeParse(owner).success &&
    RepoName.safeParse(name).success &&
    name !== "." &&
    name !== ".."
  );
};

export type ParseMemoryContextResult =
  | {
      readonly ok: true;
      readonly repository: string;
      readonly entries: readonly MemoryExportEntry[];
    }
  /** `line` is 1-based; `problem` a fixed code (never the text). */
  | { readonly ok: false; readonly line: number; readonly problem: string };

const HEADING = /^# Project memory: (.+)$/u;
const SECTION_LINE = /^## (Conventions|Decisions|Dismissals)$/u;
const REASON_LINE = /^ {2}- Reason: (.+?)(?:, covers findings up to (critical|high|medium|low))?$/u;
const EVIDENCE_LINE =
  /^ {2}- Evidence: (.+), (?:line (\d{1,9})|lines (\d{1,9})-(\d{1,9})), commit ([0-9a-f]{40}), PR #(\d{1,10})$/u;
const CONFIDENCE_LINE =
  /^ {2}- Confidence: (\d{1,3}) · (learned from a review|written by a member)( · switched off)?$/u;

const KIND_OF_SECTION: Readonly<Record<string, MemoryKind>> = {
  Conventions: "convention",
  Decisions: "decision",
  Dismissals: "dismissal",
};
const reasonOf = (label: string): DismissReason | null => {
  for (const [code, text] of Object.entries(REASON_LABEL)) {
    if (text === label && isDismissReason(code)) return code;
  }
  return null;
};
const severityOf = (value: string | undefined): Severity | null =>
  SEVERITIES.find((s) => s === value) ?? null;

interface Pending {
  readonly line: number;
  readonly kind: MemoryKind;
  readonly text: string;
  reason?: DismissReason;
  severity?: Severity | null;
  evidence?: MemoryEvidence;
  confidence?: number;
  origin?: MemoryOrigin;
  disabled?: boolean;
}

/**
 * Reads a `context.md` written by `renderMemoryContext` back into its entries. Strict: anything
 * the renderer would not write is refused with the line it is on. CRLF line ends are accepted
 * (a checkout may convert them). The entries are checked like the export checks them.
 */
export const parseMemoryContext = (markdown: string): ParseMemoryContextResult => {
  const lines = markdown.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const fail = (index: number, problem: string): ParseMemoryContextResult => ({
    ok: false,
    line: index + 1,
    problem,
  });
  const heading = HEADING.exec(lines[0] ?? "");
  if (heading?.[1] === undefined) return fail(0, "missing_heading");
  const repository = unescapeMarkdownText(heading[1]);
  if (!isRepository(repository)) return fail(0, "invalid_repository");
  for (const [i, expected] of PREAMBLE.entries()) {
    if (lines[i + 1] !== expected)
      return fail(
        i + 1,
        expected === MEMORY_EXPORT_FORMAT_LINE ? "missing_format_line" : "invalid_preamble",
      );
  }
  const format = PREAMBLE.length;

  const entries: MemoryExportEntry[] = [];
  const seen = new Set<MemoryKind>();
  let kind: MemoryKind | null = null;
  let pending: Pending | null = null;
  let empty = false;

  const close = (): string | null => {
    if (pending === null) return null;
    const p = pending;
    pending = null;
    if (p.evidence === undefined || p.confidence === undefined || p.origin === undefined)
      return "incomplete_entry";
    if ((p.kind === "dismissal") !== (p.reason !== undefined)) return "invalid_reason";
    const entry: MemoryExportEntry = {
      kind: p.kind,
      origin: p.origin,
      text: p.text,
      reason: p.reason ?? null,
      severity: p.severity ?? null,
      evidence: p.evidence,
      confidence: p.confidence,
      disabled: p.disabled ?? false,
    };
    if (!exportable(entry)) return "invalid_entry";
    entries.push(entry);
    return null;
  };

  for (let i = format + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "") continue;
    if (line === "No entries.") {
      if (kind !== null || empty) return fail(i, "unexpected_line");
      empty = true;
      continue;
    }
    const section = SECTION_LINE.exec(line);
    if (section?.[1] !== undefined) {
      const problem = close();
      if (problem !== null) return fail(i - 1, problem);
      const next = KIND_OF_SECTION[section[1]];
      if (next === undefined || seen.has(next) || empty) return fail(i, "unexpected_section");
      seen.add(next);
      kind = next;
      continue;
    }
    if (kind === null) return fail(i, "unexpected_line");
    if (line.startsWith("- ")) {
      const problem = close();
      if (problem !== null) return fail(i - 1, problem);
      pending = { line: i, kind, text: unescapeMarkdownText(line.slice(2)) };
      continue;
    }
    const current: Pending | null = pending;
    if (current === null) return fail(i, "unexpected_line");
    const reason = REASON_LINE.exec(line);
    if (reason !== null) {
      const code = reasonOf(reason[1] ?? "");
      if (code === null || current.reason !== undefined || current.evidence !== undefined)
        return fail(i, "invalid_reason");
      current.reason = code;
      current.severity = severityOf(reason[2]);
      continue;
    }
    const evidence = EVIDENCE_LINE.exec(line);
    if (evidence !== null) {
      if (current.evidence !== undefined) return fail(i, "unexpected_line");
      const start = Number(evidence[2] ?? evidence[3]);
      const end = Number(evidence[2] ?? evidence[4]);
      const pullRequestNumber = Number(evidence[6]);
      if (
        !(start >= 1 && end >= start && end <= limits.MAX_LINE_NUMBER) ||
        end - start + 1 > limits.MAX_RANGE_LINES ||
        !(pullRequestNumber >= 1 && pullRequestNumber <= limits.MAX_PR_NUMBER)
      )
        return fail(i, "invalid_evidence");
      current.evidence = {
        path: unescapeMarkdownText(evidence[1] ?? ""),
        sha: evidence[5] ?? "",
        range: { start, end },
        pullRequestNumber,
      };
      continue;
    }
    const confidence = CONFIDENCE_LINE.exec(line);
    if (confidence !== null) {
      const value = Number(confidence[1]);
      if (current.evidence === undefined || current.confidence !== undefined)
        return fail(i, "unexpected_line");
      if (!(value >= limits.MIN_CONFIDENCE && value <= limits.MAX_CONFIDENCE))
        return fail(i, "invalid_confidence");
      current.confidence = value;
      current.origin = confidence[2] === "learned from a review" ? "learned" : "member";
      current.disabled = confidence[3] !== undefined;
      continue;
    }
    return fail(i, "unexpected_line");
  }
  const problem = close();
  if (problem !== null) return fail(lines.length - 1, problem);
  return { ok: true, repository, entries };
};
