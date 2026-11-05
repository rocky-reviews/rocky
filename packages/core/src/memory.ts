import { limits, pathProblem, textProblem } from "@rocky-reviews/schema";
import { isDismissReason, type DismissReason } from "./drafts.js";
import { scrubPersonalIdentifiers, type ScrubResult } from "./pii.js";

/**
 * Project memory entries (P8-1, ADR 0036): what a repository's reviewers decided, kept so later
 * reviews can cite it. An entry is one line of text with its evidence (a path, a commit, a line
 * range and the PR it came from), a confidence, who wrote it (a member id, never a name), when a
 * review last used it, and which entry replaced it.
 *
 * `prepareMemoryEntry` is the only way to build one from untrusted input: it scrubs personal
 * identifiers out of the text first (the people the caller knows about are removed wherever they
 * appear), then applies the invariants. Learning (P8-2), the UI and export (P8-3) and decay
 * (P8-4) build on this; nothing here reads or writes storage.
 */

/** A convention of the repository, a decision its reviewers took, or a dismissed finding. */
export const MEMORY_KINDS = ["convention", "decision", "dismissal"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Who produced the entry: a person wrote it (P8-3), or P8-2 learned it from a decision. */
export const MEMORY_ORIGINS = ["member", "learned"] as const;
export type MemoryOrigin = (typeof MEMORY_ORIGINS)[number];

export const isMemoryKind = (value: unknown): value is MemoryKind =>
  typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
export const isMemoryOrigin = (value: unknown): value is MemoryOrigin =>
  typeof value === "string" && (MEMORY_ORIGINS as readonly string[]).includes(value);

/** The stored text: one line, the same cap as the quote in a finding's `MemoryRef`. */
export const MAX_MEMORY_ENTRY_TEXT_LENGTH = limits.MAX_MEMORY_TEXT_LENGTH;
/** Raw input accepted before the scrub (a scrub can lengthen or shorten the text). */
export const MAX_MEMORY_TEXT_INPUT_LENGTH = 2000;
export const MIN_MEMORY_CONFIDENCE = limits.MIN_CONFIDENCE;
export const MAX_MEMORY_CONFIDENCE = limits.MAX_CONFIDENCE;
/** What a reader shows for an author whose member row is gone or removed. */
export const FORMER_MEMBER_LABEL = "former member";

export interface MemoryEvidence {
  /** Repository-relative POSIX path (schema `pathProblem`). */
  readonly path: string;
  /** Full lowercase commit sha the lines were read at. */
  readonly sha: string;
  /** Inclusive 1-based line range, at most `MAX_RANGE_LINES` lines. */
  readonly range: { readonly start: number; readonly end: number };
  /** The pull request the evidence comes from, by number (GitHub is the source of truth). */
  readonly pullRequestNumber: number;
}

export type MemoryAuthor =
  | { readonly kind: "member"; readonly memberId: string; readonly login: string }
  | { readonly kind: "former_member" };

export interface MemoryEntry {
  readonly id: string;
  readonly repoId: string;
  readonly kind: MemoryKind;
  readonly origin: MemoryOrigin;
  readonly text: string;
  readonly evidence: MemoryEvidence;
  /** 0..100: how sure Rocky is that the entry holds. */
  readonly confidence: number;
  /** The dismissal reason; set exactly for `dismissal` entries. */
  readonly reason: DismissReason | null;
  readonly author: MemoryAuthor;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** When a review last cited the entry; `null` until one does. */
  readonly lastUsedAt: Date | null;
  /** The entry that replaced this one, or `null` while it is current. */
  readonly supersededBy: string | null;
}

/** A validated, scrubbed entry ready to be stored (the author and repository come from the caller). */
export interface MemoryEntryDraft {
  readonly kind: MemoryKind;
  readonly origin: MemoryOrigin;
  readonly text: string;
  readonly evidence: MemoryEvidence;
  readonly confidence: number;
  readonly reason: DismissReason | null;
}

export type MemoryEntryProblem =
  | "invalid_entry"
  | "invalid_kind"
  | "invalid_origin"
  | "invalid_text"
  | "text_too_long"
  | "invalid_evidence"
  | "invalid_path"
  | "invalid_sha"
  | "invalid_range"
  | "invalid_pull_request"
  | "invalid_confidence"
  | "invalid_reason";

export type PrepareMemoryEntryResult =
  | { readonly ok: true; readonly draft: MemoryEntryDraft; readonly scrubbed: ScrubResult }
  | { readonly ok: false; readonly problem: MemoryEntryProblem };

const FULL_SHA = /^[0-9a-f]{40}$/;
/**
 * Text no entry may carry (threat P3): the prompt canary (ADR 0015; a stored entry quoted into a
 * finding would trip the leak guard) and the PR-content markers (ADR 0013; an entry could
 * pretend to open or close a block).
 */
const FORBIDDEN_TEXT = /rk-canary-|<\s*\/?\s*pr_content\b/iu;

const field = (input: object, name: string): unknown =>
  Object.hasOwn(input, name) ? (input as Record<string, unknown>)[name] : undefined;

const isRecord = (value: unknown): value is object =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

const fail = (problem: MemoryEntryProblem): PrepareMemoryEntryResult => ({ ok: false, problem });

const evidenceOf = (input: unknown): MemoryEvidence | MemoryEntryProblem => {
  if (!isRecord(input)) return "invalid_evidence";
  const path = field(input, "path");
  if (
    typeof path !== "string" ||
    path.length > limits.MAX_PATH_LENGTH ||
    pathProblem(path) !== undefined
  )
    return "invalid_path";
  const sha = field(input, "sha");
  if (typeof sha !== "string" || !FULL_SHA.test(sha)) return "invalid_sha";
  const range = field(input, "range");
  if (!isRecord(range)) return "invalid_range";
  const start = field(range, "start");
  const end = field(range, "end");
  if (
    !isInt(start, 1, limits.MAX_LINE_NUMBER) ||
    !isInt(end, start, limits.MAX_LINE_NUMBER) ||
    end - start + 1 > limits.MAX_RANGE_LINES
  )
    return "invalid_range";
  const pullRequestNumber = field(input, "pullRequestNumber");
  if (!isInt(pullRequestNumber, 1, limits.MAX_PR_NUMBER)) return "invalid_pull_request";
  return { path, sha, range: { start, end }, pullRequestNumber };
};

/**
 * Builds a storable entry from untrusted input: `{ kind, origin, text, evidence, confidence,
 * reason? }`. Unknown fields are ignored; the author and the repository are never read from the
 * input. The text is scrubbed (`scrubPersonalIdentifiers` with `options.people`), whitespace is
 * collapsed to single spaces, and the result must be one line of 1..300 characters without
 * control or invisible characters, markdown links or images (schema `line` rules), the prompt
 * canary or PR-content markers. The problem codes carry no values.
 */
export const prepareMemoryEntry = (
  input: unknown,
  options: { readonly people?: readonly string[] } = {},
): PrepareMemoryEntryResult => {
  if (!isRecord(input)) return fail("invalid_entry");
  const kind = field(input, "kind");
  if (!isMemoryKind(kind)) return fail("invalid_kind");
  const origin = field(input, "origin");
  if (!isMemoryOrigin(origin)) return fail("invalid_origin");

  const rawText = field(input, "text");
  if (typeof rawText !== "string") return fail("invalid_text");
  if (rawText.length > MAX_MEMORY_TEXT_INPUT_LENGTH) return fail("text_too_long");
  const scrubbed = scrubPersonalIdentifiers(rawText, { people: options.people ?? [] });
  const text = scrubbed.text.replace(/\s+/gu, " ").trim();
  if (text.length === 0) return fail("invalid_text");
  if (text.length > MAX_MEMORY_ENTRY_TEXT_LENGTH) return fail("text_too_long");
  if (textProblem(text, "line") !== undefined || FORBIDDEN_TEXT.test(text))
    return fail("invalid_text");

  const evidence = evidenceOf(field(input, "evidence"));
  if (typeof evidence === "string") return fail(evidence);

  const confidence = field(input, "confidence");
  if (!isInt(confidence, MIN_MEMORY_CONFIDENCE, MAX_MEMORY_CONFIDENCE))
    return fail("invalid_confidence");

  const reason = field(input, "reason") ?? null;
  if (kind === "dismissal") {
    if (!isDismissReason(reason)) return fail("invalid_reason");
  } else if (reason !== null) {
    return fail("invalid_reason");
  }

  return {
    ok: true,
    draft: {
      kind,
      origin,
      text,
      evidence,
      confidence,
      reason: kind === "dismissal" && isDismissReason(reason) ? reason : null,
    },
    scrubbed,
  };
};

/**
 * The source PR number of an untrusted entry, when it is a plausible one; `null` otherwise. For
 * a caller that needs it before `prepareMemoryEntry` (to look up the PR author's login and add
 * it to the people to scrub). Reads nothing else.
 */
export const readPullRequestNumber = (input: unknown): number | null => {
  if (!isRecord(input)) return null;
  const evidence = field(input, "evidence");
  if (!isRecord(evidence)) return null;
  const number = field(evidence, "pullRequestNumber");
  return isInt(number, 1, limits.MAX_PR_NUMBER) ? number : null;
};

/** The author as shown: the login while they are a member, "former member" otherwise. */
export const memoryAuthorLabel = (author: MemoryAuthor): string =>
  author.kind === "member" ? author.login : FORMER_MEMBER_LABEL;

/** A `MemoryRef.source` for a citation: the kind and the source PR, never a person. */
export const memorySourceLabel = (entry: {
  readonly kind: MemoryKind;
  readonly evidence: { readonly pullRequestNumber: number };
}): string => `${entry.kind} · PR #${entry.evidence.pullRequestNumber}`;
