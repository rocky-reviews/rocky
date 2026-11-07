/**
 * Ask about the pull request (P9-2, ADR 0041): one question from a reviewer, answered from the
 * repository's index with citations a reviewer can open. The pure half: the prompt parts, the
 * output contract, the citation check and the flow over ports. The server supplies the ports
 * (the metered embed role, `searchCodeChunks` inside `withOrg`, and a reader that re-fetches each
 * hit's lines from GitHub by blob id on a short-lived read-only token); the eval suite supplies
 * in-memory ones (`packages/evals/src/ask`).
 *
 * Everything that varies per question is untrusted input: the question and the selection (a
 * reviewer typed or picked them, but they may be pasted from the PR), the paths and the code. It
 * travels in `untrusted` parts under Rocky's labels, never in the instructions, and the answer
 * goes through `completeWithRepair` (schema, then the leak guard). The answer is data for the
 * reviewer to read: nothing here, or downstream, acts on it.
 *
 * A citation is kept only when it points into an excerpt the model was actually shown: the same
 * path, and a line range inside the lines shown from that excerpt. Every other citation is
 * dropped (and counted) before the answer leaves this module, so it can never become a link.
 * An answer left with no valid citation is not served as an answer (`no_answer: uncited`).
 */
import { limits, textProblem } from "@rocky-reviews/schema";
import { z } from "zod";
import { ASK_INSTRUCTIONS } from "./analysis/instructions.js";
import { outputSchema } from "./analysis/outputs.js";
import { completeWithRepair, type CallObserver, type UnitFailure } from "./analysis/repair.js";
import { INDEX_LIMITS, type EmbeddingSpace } from "./indexing.js";
import type {
  EmbeddingRoleClient,
  LlmRoles,
  LlmUntrustedText,
  StructuredCompletionResult,
} from "./llm.js";

export const ASK_LIMITS = Object.freeze({
  /** A question longer than this is refused (the panel's box enforces it too). */
  maxQuestionChars: 2_000,
  /** The selected code sent with a question, at most. */
  maxSelectionChars: 4_000,
  /** Excerpts searched for and shown to the model. */
  contextChunks: 8,
  /** Characters of code shown per excerpt (the index cuts its chunks at the same size). */
  maxExcerptChars: INDEX_LIMITS.maxChunkChars,
  /** A longer line is cut (and marked) in the excerpt; it still counts as shown. */
  maxLineChars: 500,
  maxCitations: 8,
  maxAnswerChars: limits.MAX_BODY_LENGTH,
  /** Thinking counts against it (ADR 0012 N9), as for the pipeline's calls. */
  maxOutputTokens: 16_000,
});

export const ASK_LABELS = Object.freeze({
  question: "question",
  selection: "selection",
  code: "code",
});

const textField = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .superRefine((text, context) => {
      // The schema's prose rule (P4-4, ADR 0015 I12): no control or invisible characters, no
      // markdown image, absolute link, autolink or link definition.
      const problem = textProblem(text, "prose");
      if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
    });

const Line = z.int().min(1).max(limits.MAX_LINE_NUMBER);

export const AskCitation = z
  .strictObject({
    path: z.string().min(1).max(limits.MAX_PATH_LENGTH).describe("An excerpt's path, exactly."),
    start: Line.describe("First cited line, as numbered in that excerpt."),
    end: Line.describe("Last cited line, as numbered in that excerpt."),
  })
  .refine((c) => c.end >= c.start, { message: "end must be at least start", path: ["end"] });
export type AskCitation = z.output<typeof AskCitation>;

export const AskAnswer = z
  .strictObject({
    answered: z
      .boolean()
      .describe("False when the excerpts do not hold the answer (then no citations)."),
    answer: textField(ASK_LIMITS.maxAnswerChars).describe(
      "The answer in a few sentences of markdown with inline code; or what is missing.",
    ),
    citations: z.array(AskCitation).max(ASK_LIMITS.maxCitations),
  })
  .describe("An answer to the reviewer's question, from the code excerpts only.");
export type AskAnswer = z.output<typeof AskAnswer>;

export const ASK_OUTPUT = outputSchema("rocky_ask", AskAnswer);

/** Code the reviewer selected in the diff and sent with the question (`/`). */
export interface AskSelection {
  readonly path: string;
  /** New-side lines of the pull request's diff. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export interface AskRequest {
  readonly question: string;
  readonly selection?: AskSelection;
}

/** Why a request is refused before anything is asked. Fixed codes. */
export type AskRequestProblem =
  "question_empty" | "question_too_long" | "question_text" | "selection_invalid";

/** A request the flow may run, or the first problem with it. Never echoes the input. */
export const checkAskRequest = (
  request: AskRequest,
): { readonly ok: true } | { readonly ok: false; readonly problem: AskRequestProblem } => {
  const question = typeof request.question === "string" ? request.question.trim() : "";
  if (question.length === 0) return { ok: false, problem: "question_empty" };
  if (question.length > ASK_LIMITS.maxQuestionChars)
    return { ok: false, problem: "question_too_long" };
  // A question may hold pasted code (tabs, newlines) and URLs; never other control characters.
  // eslint-disable-next-line no-control-regex
  if (!question.isWellFormed() || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(question))
    return { ok: false, problem: "question_text" };
  const s = request.selection;
  if (s !== undefined) {
    const ok =
      typeof s === "object" &&
      s !== null &&
      typeof s.path === "string" &&
      s.path.length > 0 &&
      s.path.length <= limits.MAX_PATH_LENGTH &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(s.path) &&
      Number.isInteger(s.startLine) &&
      Number.isInteger(s.endLine) &&
      s.startLine >= 1 &&
      s.endLine >= s.startLine &&
      s.endLine <= limits.MAX_LINE_NUMBER &&
      typeof s.text === "string" &&
      s.text.length > 0 &&
      s.text.length <= ASK_LIMITS.maxSelectionChars &&
      s.text.isWellFormed();
    if (!ok) return { ok: false, problem: "selection_invalid" };
  }
  return { ok: true };
};

/** A nearest chunk, as the index locates it (no text: the index stores none). */
export interface AskHit {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** A hit's lines, read from the file at the indexed commit (`lines[0]` is `startLine`). */
export interface AskExcerptSource extends AskHit {
  readonly lines: readonly string[];
}

/** What the model was shown of one hit: the lines `startLine`..`shownEnd`. */
export interface AskExcerpt {
  readonly path: string;
  readonly startLine: number;
  /** The last line shown (the excerpt may be cut at `maxExcerptChars`). */
  readonly shownEnd: number;
  readonly part: LlmUntrustedText;
}

const SAFE_LINE = (line: string): string => {
  // Line ends and the odd carriage return are the file's, not the excerpt's layout.
  const text = line.replace(/\r$/, "");
  return text.length > ASK_LIMITS.maxLineChars
    ? `${text.slice(0, ASK_LIMITS.maxLineChars)} [cut]`
    : text;
};

/**
 * One excerpt as the model sees it: the path, the range shown, then each line numbered. Lines are
 * added while they fit `maxExcerptChars`; an excerpt with no line that fits shows its first line
 * cut. `undefined` for a source without lines or with a range that is not its own.
 */
export const excerptOf = (source: AskExcerptSource): AskExcerpt | undefined => {
  const { path, startLine, endLine, lines } = source;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    lines.length === 0 ||
    lines.length > endLine - startLine + 1
  ) {
    return undefined;
  }
  const shown: string[] = [];
  let size = 0;
  for (const [i, raw] of lines.entries()) {
    const line = `${startLine + i}| ${SAFE_LINE(raw)}`;
    if (shown.length > 0 && size + line.length + 1 > ASK_LIMITS.maxExcerptChars) break;
    shown.push(line);
    size += line.length + 1;
  }
  const shownEnd = startLine + shown.length - 1;
  return {
    path,
    startLine,
    shownEnd,
    part: {
      label: ASK_LABELS.code,
      text: `path: ${path}\nlines: ${startLine}-${shownEnd}\n${shown.join("\n")}`,
    },
  };
};

/** The question and the selection as the model sees them. */
export const requestParts = (request: AskRequest): LlmUntrustedText[] => {
  const parts: LlmUntrustedText[] = [{ label: ASK_LABELS.question, text: request.question.trim() }];
  const s = request.selection;
  if (s !== undefined) {
    parts.push({
      label: ASK_LABELS.selection,
      text: `path: ${s.path}\nlines: ${s.startLine}-${s.endLine} (new side of the diff)\n${s.text}`,
    });
  }
  return parts;
};

/** What the question is embedded as: the question, then the selection's path and code. */
export const queryInput = (request: AskRequest): string => {
  const s = request.selection;
  return s === undefined
    ? request.question.trim()
    : `${request.question.trim()}\n${s.path}\n${s.text}`;
};

export interface CheckedCitations {
  /** Citations inside a shown excerpt, deduplicated, in the model's order. */
  readonly valid: readonly AskCitation[];
  /** Citations that pointed anywhere else (dropped). */
  readonly dropped: number;
}

/** Keeps only citations that point into an excerpt the model was shown (see the module comment). */
export const checkCitations = (
  citations: readonly AskCitation[],
  excerpts: readonly Pick<AskExcerpt, "path" | "startLine" | "shownEnd">[],
): CheckedCitations => {
  const valid: AskCitation[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const c of citations) {
    const inside = excerpts.some(
      (e) => e.path === c.path && c.start >= e.startLine && c.end <= e.shownEnd && c.end >= c.start,
    );
    const key = `${c.start}:${c.end}:${c.path}`;
    if (!inside) dropped++;
    else if (!seen.has(key)) {
      seen.add(key);
      valid.push({ path: c.path, start: c.start, end: c.end });
    }
  }
  return { valid, dropped };
};

/** `H`: the search's own hit type (the server's carries the blob id its reader needs). */
export interface AskPorts<H extends AskHit = AskHit> {
  /** The embed role, metered by the caller. */
  readonly embedding: EmbeddingRoleClient;
  /** The space the repository's index is in; the query vector must be made in it. */
  readonly space: EmbeddingSpace;
  /** The `k` nearest chunks of the repository's index to a vector of `space`. */
  search(vector: readonly number[], k: number): Promise<readonly H[]>;
  /** Each hit's lines at the indexed commit, in order; `null` for a hit that cannot be read. */
  read(hits: readonly H[]): Promise<readonly (AskExcerptSource | null)[]>;
}

export type AskOutcome =
  | {
      readonly kind: "answer";
      readonly answer: string;
      readonly citations: readonly AskCitation[];
      /** Citations the model gave that pointed outside what it was shown. */
      readonly dropped: number;
      readonly excerpts: number;
    }
  | {
      readonly kind: "no_answer";
      /**
       * `no_context`: the index gave nothing readable; `model`: the model said the excerpts do
       * not hold the answer; `uncited`: it answered but cited nothing it was shown.
       */
      readonly reason: "no_context" | "model" | "uncited";
      /** The model's note on what is missing (`model` only). */
      readonly note: string | null;
      readonly dropped: number;
      readonly excerpts: number;
    }
  /** The model refused, was cut off, or answered invalid output twice. */
  | { readonly kind: "failed"; readonly reason: UnitFailure };

export interface AskOptions {
  readonly signal?: AbortSignal;
  /** Every model call that reached the provider (for logs and evals: counts only). */
  readonly onResult?: (result: StructuredCompletionResult<unknown>) => void;
}

/** The query vector came back in another width than the index's space. */
export class AskSpaceError extends Error {
  override readonly name = "AskSpaceError";
  constructor() {
    super("ask: the query vector is not in the index's embedding space");
  }
}

/**
 * The flow: embed the question in the index's space, search, read the hits' lines, ask the
 * `ask` role, keep the valid citations. LLM call errors other than a too-large input or a
 * timeout are thrown for the caller to map (as the pipeline does).
 */
export const answerQuestion = async <H extends AskHit>(
  llm: LlmRoles,
  ports: AskPorts<H>,
  request: AskRequest,
  options: AskOptions = {},
): Promise<AskOutcome> => {
  const checked = checkAskRequest(request);
  if (!checked.ok) throw new RangeError(`ask: ${checked.problem}`);
  const embedded = await ports.embedding.embed({
    inputs: [queryInput(request)],
    purpose: "query",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const vector = embedded.vectors[0];
  // The embed role is configured in the index's space (the caller checks that); a vector of
  // another width cannot be compared with it.
  if (vector === undefined || vector.length !== ports.space.dimensions) throw new AskSpaceError();
  const hits = await ports.search(vector, ASK_LIMITS.contextChunks);
  const sources = hits.length === 0 ? [] : await ports.read(hits);
  const excerpts = sources.flatMap((source) => {
    const excerpt = source === null ? undefined : excerptOf(source);
    return excerpt === undefined ? [] : [excerpt];
  });
  if (excerpts.length === 0)
    return { kind: "no_answer", reason: "no_context", note: null, dropped: 0, excerpts: 0 };

  const observer: CallObserver = {
    onResult: (_role, result) => options.onResult?.(result),
  };
  const result = await completeWithRepair(
    llm,
    {
      role: "ask",
      instructions: ASK_INSTRUCTIONS,
      untrusted: [...requestParts(request), ...excerpts.map((e) => e.part)],
      output: ASK_OUTPUT,
      maxOutputTokens: ASK_LIMITS.maxOutputTokens,
      check: () => [],
    },
    observer,
    options.signal,
  );
  if (!result.ok) return { kind: "failed", reason: result.reason };
  const answer = result.value;
  const { valid, dropped } = checkCitations(answer.citations, excerpts);
  if (!answer.answered)
    return {
      kind: "no_answer",
      reason: "model",
      note: answer.answer,
      dropped: answer.citations.length,
      excerpts: excerpts.length,
    };
  if (valid.length === 0)
    return { kind: "no_answer", reason: "uncited", note: null, dropped, excerpts: excerpts.length };
  return {
    kind: "answer",
    answer: answer.answer,
    citations: valid,
    dropped,
    excerpts: excerpts.length,
  };
};
