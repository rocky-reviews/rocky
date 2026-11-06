/**
 * The per-PR token estimate (P4-6, ADR 0017 §5), made before any model call. It is cheap and
 * deterministic: the same diff and the same previous analysis always give the same number, and
 * it reads nothing but the diff. It counts what the pipeline would send:
 *
 * - the patch of every file left after rules pre-triage (noise excluded), except binary and
 *   too-large files (never sent) and files whose unit the previous analysis will be reused for:
 *   ASCII at CHARS_PER_TOKEN, any other text one token per UTF-8 byte (`patchTokens`);
 * - the patch of every file the change map's calls read again (H4-7, review round 1): the map
 *   scope's files (`changeMapScope`, the same deterministic rule the pipeline applies), once per
 *   call on the graph role (the map, its flows, its walkthrough), reused units included, since
 *   those calls run on every push; nothing when there is nothing to map or the mapped diff is
 *   over the map's input budget, because then no call on the graph role is made;
 * - the project-memory part a file's review would carry (P8-2), for every file sent, as if each
 *   were reviewed (an upper bound: only critical and important files are);
 * - a fixed overhead per file call (instructions, labels, the answer) and per stage: the unit
 *   stages (triage, review, briefing) always, the map's stages only when there is a map.
 *
 * It is a size, not a bill: the review reads a critical or important file's patch again, and a
 * repair round repeats a call (a PR author can force one per call, so the graph-role re-reads
 * can double), so spend is a small multiple of it. The worker compares it with the per-PR limit;
 * over the limit the analysis waits for a person ("Analyze anyway") and no model is called.
 */
import { parseUnifiedDiff } from "./diff.js";
import { changeMapScope, GRAPH_MAX_INPUT_CHARS, type ScopedFile } from "./map-scope.js";
import { memoryKeyOf, memoryPart, selectMemory, type AnalysisMemoryEntry } from "./memory.js";
import { preTriage } from "./rules.js";
import { unitKey, type PreviousAnalysis, type Sha256Hex } from "./units.js";

/** ASCII characters per token: conservative for code (English prose is nearer 4). */
export const CHARS_PER_TOKEN = 3;

/**
 * An upper bound for any text (review round 1, SF2): ASCII at CHARS_PER_TOKEN, and every UTF-8
 * byte of anything else as one token. Tokenizers spend at most about one token per byte on text
 * outside their common vocabulary (byte fallback), so CJK, emoji or a padding of look-alikes
 * cannot make a large diff look small, as counting UTF-16 units would.
 */
export const patchTokens = (text: string): number => {
  let ascii = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) {
      ascii++;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate pair is one code point of 4 bytes.
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN) + bytes;
};
/** One triage call's instructions, labels and answer, on top of the file's patch. */
export const FILE_CALL_OVERHEAD_TOKENS = 2_000;
/** Per stage: instructions, preamble and the stage's answer. */
export const STAGE_OVERHEAD_TOKENS = 4_000;
/** The stages every analysed PR runs: triage, review, briefing. */
export const UNIT_STAGES = 3;
/** The stages a PR with a map runs on top: the map, its flows, its walkthrough (H4-7). */
export const MAP_STAGES = 3;
export const ANALYSIS_STAGES = UNIT_STAGES + MAP_STAGES;
/** Calls on the graph role, each of which reads the mapped diffs: one per map stage. */
export const GRAPH_ROLE_CALLS = MAP_STAGES;
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
  /** Files the change map's calls read again (the map scope), each `GRAPH_ROLE_CALLS` times. */
  readonly mapped: number;
}

export interface EstimateOptions {
  /** The pull request's last good analysis; with `sha256Hex`, its units are not counted. */
  readonly previous?: PreviousAnalysis | undefined;
  readonly sha256Hex?: Sha256Hex;
  /** The same salt the pipeline mixes into unit keys. */
  readonly unitKeySalt?: string;
  /**
   * The repository's project memory, as the pipeline will be given it (P8-2): it is part of a
   * file's unit key, and its part is sent with the file's review. The pipeline re-checks entries
   * (`usableMemory`); the estimate counts them as given, which can only count more.
   */
  readonly memory?: readonly AnalysisMemoryEntry[] | undefined;
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
  const memory = options.memory ?? [];
  let patch = 0;
  let sent = 0;
  let noise = 0;
  let skipped = 0;
  let reused = 0;
  /** Every file the rules leave to the AI, mappable when a model could be given it (S5). */
  const candidates: ScopedFile[] = [];
  const patchOf = new Map<string, string>();
  for (const file of parsed.files) {
    if (preTriage(file.path).kind === "noise") {
      noise++;
      continue;
    }
    const mappable = !file.binary && !file.tooLarge;
    candidates.push({ path: file.path, mappable });
    if (!mappable) {
      skipped++;
      continue;
    }
    patchOf.set(file.path, file.patch);
    const selection = selectMemory(memory, file.path);
    if (
      sha256Hex !== undefined &&
      keys.size > 0 &&
      keys.has(`${file.path}\0${unitKey(sha256Hex, salt, file, memoryKeyOf(selection))}`)
    ) {
      reused++;
    } else {
      sent++;
      patch += patchTokens(file.patch);
      if (selection.length > 0) patch += patchTokens(memoryPart(selection).text);
    }
  }
  // The map's calls read the mapped diffs again, on every push, unless there is no map.
  const scope = changeMapScope(candidates);
  const mappedPaths = scope.kind === "logic" || scope.kind === "tests" ? scope.paths : [];
  const mappedPatches = mappedPaths.map((path) => patchOf.get(path) ?? "");
  const mappedChars = mappedPatches.reduce((sum, text) => sum + text.length, 0);
  const mapped = mappedChars > GRAPH_MAX_INPUT_CHARS ? [] : mappedPatches;
  const reread = mapped.reduce((sum, text) => sum + patchTokens(text), 0) * GRAPH_ROLE_CALLS;
  const stages = UNIT_STAGES + (mapped.length > 0 ? MAP_STAGES : 0);
  return {
    tokens: patch + reread + sent * FILE_CALL_OVERHEAD_TOKENS + stages * STAGE_OVERHEAD_TOKENS,
    files: parsed.files.length,
    sent,
    noise,
    skipped,
    reused,
    mapped: mapped.length,
  };
};
