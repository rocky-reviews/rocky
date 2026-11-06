import { createHash } from "node:crypto";
import {
  embeddingTokens,
  INDEX_VECTOR_DIMENSIONS,
  type EmbeddingResult,
  type EmbeddingRoleClient,
} from "@rocky-reviews/core";

/**
 * A deterministic stand-in for an embedding provider (P9-1): the indexing tests and
 * `pnpm index:bench` run on it, so no provider is called and no key is needed. The same text
 * always gives the same unit vector (seeded from its sha256), different texts almost never the
 * same one. Usage is the token estimate of the inputs. A simulated latency per call and a batch
 * limit let the benchmark stand in for a real provider's round trips.
 *
 * It is never a configured provider: the worker builds its embedder from `ROCKY_LLM_EMBED_*`
 * only, and this module is not reachable from that configuration.
 */

export interface DeterministicEmbedderOptions {
  readonly dimensions: number;
  /** Milliseconds each call waits before answering (default 0). */
  readonly latencyMs?: number;
  /** Most inputs one call takes (default 128); more is refused, as a provider would. */
  readonly maxBatch?: number;
}

export interface DeterministicEmbedder extends EmbeddingRoleClient {
  readonly provider: "fake";
  readonly model: string;
  readonly dimensions: number;
  /** Calls made so far. */
  readonly calls: number;
}

/** A pseudo-random unit vector from the text's digest (xorshift seeded per block). */
const vectorOf = (text: string, dimensions: number): number[] => {
  const out = new Array<number>(dimensions);
  let block = 0;
  let state = 0;
  for (let i = 0; i < dimensions; i++) {
    if (i % 8 === 0) {
      const digest = createHash("sha256").update(`${block++}:${text}`).digest();
      state = digest.readUInt32LE(0) | 1;
    }
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[i] = ((state >>> 0) / 0xffffffff) * 2 - 1;
  }
  const norm = Math.hypot(...out) || 1;
  return out.map((x) => x / norm);
};

export const deterministicEmbedder = (
  options: DeterministicEmbedderOptions,
): DeterministicEmbedder => {
  const { dimensions } = options;
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > INDEX_VECTOR_DIMENSIONS) {
    throw new RangeError("deterministicEmbedder: dimensions must be 1..1024");
  }
  const maxBatch = options.maxBatch ?? 128;
  const latencyMs = options.latencyMs ?? 0;
  let calls = 0;
  const model = `deterministic-${dimensions}`;
  return {
    provider: "fake",
    model,
    dimensions,
    get calls() {
      return calls;
    },
    embed: async (request): Promise<EmbeddingResult> => {
      calls++;
      if (request.inputs.length > maxBatch) throw new RangeError("batch too large");
      if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
      return {
        vectors: request.inputs.map((input) => vectorOf(input, dimensions)),
        model,
        provider: "fake",
        usage: { inputTokens: embeddingTokens(request.inputs) },
      };
    },
  };
};
