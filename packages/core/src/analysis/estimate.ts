/**
 * The per-PR token estimate (P4-6, ADR 0017 §5), made before any model call. It is cheap and
 * deterministic: the same diff and the same previous analysis always give the same number, and
 * it reads nothing but the diff. It counts what the pipeline would send:
 *
 * - the patch of every file left after rules pre-triage (noise excluded), except binary and
 *   too-large files (never sent) and files whose unit the previous analysis will be reused for;
 * - a fixed overhead per file call (instructions, labels, the answer) and per stage.
 *
 * It is a size, not a bill: the review and the change map read parts of the diff again, so spend
 * is a small multiple of it. The worker compares it with the per-PR limit; over the limit the
 * analysis waits for a person ("Analyze anyway") and no model is called.
 */
import { parseUnifiedDiff } from "./diff.js";
import { preTriage } from "./rules.js";
import { unitKey, type PreviousAnalysis, type Sha256Hex } from "./units.js";

/** Characters per token: conservative for code (English prose is nearer 4). */
export const CHARS_PER_TOKEN = 3;
/** One triage call's instructions, labels and answer, on top of the file's patch. */
export const FILE_CALL_OVERHEAD_TOKENS = 2_000;
/** Per stage (triage, review, graph, briefing): instructions, preamble and the stage's answer. */
export const STAGE_OVERHEAD_TOKENS = 4_000;
export const ANALYSIS_STAGES = 4;
/**
 * The default per-PR limit (`ROCKY_ANALYSIS_TOKEN_LIMIT`): about 450 KB of code sent, far beyond
 * a reviewable pull request, well below a 200k-token one.
 */
export const DEFAULT_ANALYSIS_TOKEN_LIMIT = 150_000;

/** Counts only: safe to log and store. */
export interface TokenEstimate {
  readonly tokens: number;
  /** Files in the diff. */
  readonly files: number;
  /** Files whose patch is counted (what triage would read). */
  readonly sent: number;
  /** Files rules pre-triage marks as noise. */
  readonly noise: number;
  /** Binary or too-large files: never sent. */
  readonly skipped: number;
  /** Files the previous analysis's units cover (same path and key). */
  readonly reused: number;
}

export interface EstimateOptions {
  /** The pull request's last good analysis; with `sha256Hex`, its units are not counted. */
  readonly previous?: PreviousAnalysis | undefined;
  readonly sha256Hex?: Sha256Hex;
  /** The same salt the pipeline mixes into unit keys. */
  readonly unitKeySalt?: string;
}

/**
 * Undefined when the diff does not parse or has no files: the pipeline refuses those itself,
 * before any model call, so there is nothing to limit.
 */
export const estimateAnalysisTokens = (
  diff: string,
  options: EstimateOptions = {},
): TokenEstimate | undefined => {
  const parsed = parseUnifiedDiff(diff);
  if (!parsed.ok || parsed.files.length === 0) return undefined;
  const { previous, sha256Hex } = options;
  const salt = options.unitKeySalt ?? "";
  const keys = new Set(
    previous === undefined ? [] : previous.units.map((unit) => `${unit.path}\0${unit.key}`),
  );
  let chars = 0;
  let sent = 0;
  let noise = 0;
  let skipped = 0;
  let reused = 0;
  for (const file of parsed.files) {
    if (preTriage(file.path).kind === "noise") {
      noise++;
    } else if (file.binary || file.tooLarge) {
      skipped++;
    } else if (
      sha256Hex !== undefined &&
      keys.size > 0 &&
      keys.has(`${file.path}\0${unitKey(sha256Hex, salt, file)}`)
    ) {
      reused++;
    } else {
      sent++;
      chars += file.patch.length;
    }
  }
  return {
    tokens:
      Math.ceil(chars / CHARS_PER_TOKEN) +
      sent * FILE_CALL_OVERHEAD_TOKENS +
      ANALYSIS_STAGES * STAGE_OVERHEAD_TOKENS,
    files: parsed.files.length,
    sent,
    noise,
    skipped,
    reused,
  };
};
