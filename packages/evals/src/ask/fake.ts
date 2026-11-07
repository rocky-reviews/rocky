/**
 * The Ask eval's `--fake` model (P9-2): no network, deterministic. It tests the harness and the
 * citation guard, never a model.
 *
 * - `lexicalEmbedder`: a bag of words hashed into a fixed width (identifiers split at camelCase),
 *   so the in-memory search finds chunks that share words with the question, as a real embedder
 *   would find related ones.
 * - `askFakeScript`: answers from the excerpt sharing most words with the question and cites the
 *   range it was shown (the `lines:` header core writes), as a careful model does.
 */
import { ASK_LABELS, type EmbeddingRoleClient } from "@rocky-reviews/core";
import type { Script, ScriptedAnswer } from "@rocky-reviews/core/testing";

export const LEXICAL_DIMENSIONS = 256;

const STOP = new Set(
  "the and are for how does what when with this that from into its which who where can has have not one".split(
    " ",
  ),
);

/** Lowercase words of a text, identifiers split at their humps; short and common words dropped. */
export const words = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    // A crude stem, so "hashed" meets "hash" and "sessions" meets "session".
    .map((w) => w.replace(/(ed|es|s)$/, ""));

const bucket = (word: string): number => {
  let h = 2166136261;
  for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
  return (h >>> 0) % LEXICAL_DIMENSIONS;
};

const vectorOf = (text: string): number[] => {
  const out = new Array<number>(LEXICAL_DIMENSIONS).fill(0);
  for (const w of words(text)) out[bucket(w)] = (out[bucket(w)] ?? 0) + 1;
  const norm = Math.hypot(...out);
  return norm === 0 ? out : out.map((x) => x / norm);
};

export const LEXICAL_SPACE = {
  provider: "fake",
  model: `lexical-${LEXICAL_DIMENSIONS}`,
  dimensions: LEXICAL_DIMENSIONS,
} as const;

export const lexicalEmbedder = (): EmbeddingRoleClient => ({
  embed: async (request) => ({
    vectors: request.inputs.map(vectorOf),
    model: LEXICAL_SPACE.model,
    provider: LEXICAL_SPACE.provider,
    usage: {
      inputTokens: request.inputs.reduce((n, input) => n + Math.ceil(input.length / 4), 0),
    },
  }),
});

interface Shown {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const HEADER = /^path: (.+)\nlines: (\d+)-(\d+)\n/;

const shown = (text: string): Shown | undefined => {
  const m = HEADER.exec(text);
  if (m === null) return undefined;
  return { path: m[1] ?? "", start: Number(m[2]), end: Number(m[3]), text };
};

export const askFakeScript: Script = (call): ScriptedAnswer => {
  if (call.role !== "ask") return { status: "refused" };
  const question = new Set(words(call.part(ASK_LABELS.question) ?? ""));
  const excerpts = call.untrusted
    .filter((p) => p.label === ASK_LABELS.code)
    .flatMap((p) => {
      const s = shown(p.text);
      return s === undefined ? [] : [s];
    });
  let best: Shown | undefined;
  let bestScore = -1;
  for (const e of excerpts) {
    const score = words(e.text).filter((w) => question.has(w)).length;
    if (score > bestScore) {
      best = e;
      bestScore = score;
    }
  }
  if (best === undefined)
    return { value: { answered: false, answer: "No excerpt was shown.", citations: [] } };
  return {
    value: {
      answered: true,
      answer: `The code in ${best.path} answers this.`,
      citations: [{ path: best.path, start: best.start, end: best.end }],
    },
  };
};
