/**
 * Runs the Ask eval (P9-2): indexes `ASK_REPO` as production does (tree-sitter chunks from
 * `@rocky-reviews/indexer`, each embedded as `embeddingInput(path, chunk)`), then asks every
 * question through core's `answerQuestion` with in-memory ports: the search is cosine similarity
 * over the chunks' vectors, and the reader hands back the hit's lines from the repository. Scores
 * with `score.ts`. Embedding tokens are counted here (the meter counts the `ask` role's calls).
 */
import {
  answerQuestion,
  embeddingInput,
  isLlmCallError,
  type AskHit,
  type AskPorts,
  type EmbeddingRoleClient,
  type EmbeddingSpace,
  type LlmRoles,
} from "@rocky-reviews/core";
import { createTreeSitterChunker, prepareFile } from "@rocky-reviews/indexer";
import { ASK_QUESTIONS, type AskQuestion } from "./questions.js";
import { ASK_REPO, askRepoText } from "./repo.js";
import { scoreAsk, scoreQuestion, type AskRunResult, type AskScore } from "./score.js";

export interface AskEvalOptions {
  /** The roles, metered by the caller; the `ask` role answers. */
  readonly llm: LlmRoles;
  readonly embedding: EmbeddingRoleClient;
  readonly space: EmbeddingSpace;
  /** The caller's token cap stopped the run. */
  readonly capped: () => boolean;
  readonly questions?: readonly AskQuestion[];
  readonly onProgress?: (line: string) => void;
}

export interface AskEvalResult extends AskScore {
  readonly status: "done" | "capped";
  readonly chunks: number;
  readonly embeddingTokens: number;
}

interface IndexedChunk extends AskHit {
  readonly vector: readonly number[];
}

const cosine = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
};

/** The repository's chunks, as the indexer cuts them. */
export const askRepoChunks = async (): Promise<
  { path: string; start: number; end: number; input: string }[]
> => {
  const chunker = await createTreeSitterChunker();
  const out: { path: string; start: number; end: number; input: string }[] = [];
  for (const path of Object.keys(ASK_REPO)) {
    const prepared = await prepareFile(chunker, path, new TextEncoder().encode(askRepoText(path)));
    if (prepared.kind !== "chunks") continue;
    for (const chunk of prepared.chunks)
      out.push({
        path,
        start: chunk.startLine,
        end: chunk.endLine,
        input: embeddingInput(path, chunk),
      });
  }
  return out;
};

export const runAskEval = async (options: AskEvalOptions): Promise<AskEvalResult> => {
  const questions = options.questions ?? ASK_QUESTIONS;
  let embeddingTokens = 0;
  const metered: EmbeddingRoleClient = {
    embed: async (request) => {
      const result = await options.embedding.embed(request);
      // No reported usage is charged as the input's length (a token per 4 characters).
      embeddingTokens +=
        result.usage?.inputTokens ??
        request.inputs.reduce((n, input) => n + Math.ceil(input.length / 4), 0);
      return result;
    },
  };

  const cut = await askRepoChunks();
  const embedded = await metered.embed({ inputs: cut.map((c) => c.input), purpose: "document" });
  const chunks: IndexedChunk[] = cut.map((c, i) => ({
    path: c.path,
    startLine: c.start,
    endLine: c.end,
    vector: embedded.vectors[i] ?? [],
  }));

  const ports: AskPorts = {
    embedding: metered,
    space: options.space,
    search: async (vector, k) =>
      chunks
        .map((chunk) => ({ chunk, score: cosine(vector, chunk.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map(({ chunk }) => ({
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        })),
    read: async (hits) =>
      hits.map((hit) => {
        const lines = ASK_REPO[hit.path];
        return lines === undefined
          ? null
          : { ...hit, lines: lines.slice(hit.startLine - 1, hit.endLine) };
      }),
  };

  const results = [];
  for (const q of questions) {
    let result: AskRunResult;
    if (options.capped()) {
      result = { id: q.id, status: "capped", reason: null, valid: [], dropped: 0, excerpts: 0 };
    } else {
      try {
        const outcome = await answerQuestion(
          options.llm,
          ports,
          q.selection === undefined
            ? { question: q.question }
            : { question: q.question, selection: q.selection },
        );
        result =
          outcome.kind === "answer"
            ? {
                id: q.id,
                status: "answer",
                reason: null,
                valid: outcome.citations,
                dropped: outcome.dropped,
                excerpts: outcome.excerpts,
              }
            : outcome.kind === "no_answer"
              ? {
                  id: q.id,
                  status: "no_answer",
                  reason: outcome.reason,
                  valid: [],
                  dropped: outcome.dropped,
                  excerpts: outcome.excerpts,
                }
              : {
                  id: q.id,
                  status: "failed",
                  reason: outcome.reason,
                  valid: [],
                  dropped: 0,
                  excerpts: 0,
                };
      } catch (error) {
        if (!isLlmCallError(error)) throw error;
        // The cap refuses a call as `cancelled`; any other call error fails the question.
        result = {
          id: q.id,
          status: options.capped() && error.kind === "cancelled" ? "capped" : "failed",
          reason: error.kind,
          valid: [],
          dropped: 0,
          excerpts: 0,
        };
      }
    }
    const scored = scoreQuestion(result, q.targets);
    results.push(scored);
    options.onProgress?.(
      `ask ${scored.id}: ${scored.status}${scored.reason === null ? "" : ` (${scored.reason})`}, ${scored.validCitations} valid, ${scored.invalidCitations} invalid${scored.targetHit ? ", on target" : ""}`,
    );
  }
  const score = scoreAsk(results);
  return {
    ...score,
    status: results.some((r) => r.status === "capped") ? "capped" : "done",
    chunks: chunks.length,
    embeddingTokens,
  };
};
