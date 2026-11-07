import {
  ForgeReadError,
  INDEX_LIMITS,
  type AskExcerptSource,
  type CodeReader,
} from "@rocky-reviews/core";

/**
 * The lines of each search hit, read from GitHub when a question is asked (P9-2, ADR 0041 §3).
 * The index stores no code (ADR 0040 §5), so the text the model is shown is read here, the way
 * the diff is (H4-3, ADR 0034):
 *
 * 1. `forge.openCode` mints an installation token for that one repository id with
 *    `contents: read` only (the answer is checked, or the token is revoked and refused; it never
 *    leaves the adapter's closure);
 * 2. when the index is not settled at its commit (a run is under way, queued after a failure, or
 *    failed part-way), the commit's tree is read and a hit whose path does not hold that blob at
 *    the indexed commit is dropped: an excerpt is always of the file at the indexed head, which
 *    is where its citation link points. A settled index (`done`) holds exactly that commit's
 *    files, so the tree is not read;
 * 3. each distinct blob is read once by its id (exact, whatever the branch did since), decoded
 *    as strict UTF-8 and cut to the hit's lines; a blob that is gone, too large, not UTF-8 or
 *    shorter than the hit makes that hit `null`;
 * 4. the session is closed (the token revoked) in `finally`, whatever happened.
 *
 * Code is untrusted: never logged, never stored, never cached. Results carry counts for the
 * route's log line.
 */

export interface AskReadHit {
  readonly path: string;
  readonly blobSha: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface AskReadTarget {
  readonly installationId: number;
  readonly repositoryId: number;
  /** The commit the index holds (citation links point at it). */
  readonly indexedSha: string;
  /** Read the commit's tree and drop hits whose blob is not the one at that commit. */
  readonly verifyAtCommit: boolean;
}

export type AskReadResult =
  | {
      readonly kind: "ok";
      /** One per hit, in order; `null` for a hit that cannot be shown. */
      readonly sources: readonly (AskExcerptSource | null)[];
      /** Blobs read from GitHub. */
      readonly blobs: number;
    }
  /** The installation cannot read the repository any more. */
  | { readonly kind: "not_found" }
  /** An outage or an answer that is not what was asked (`ForgeReadError.code`). */
  | { readonly kind: "forge_failed"; readonly code: string };

export interface AskExcerptReader {
  read(target: AskReadTarget, hits: readonly AskReadHit[]): Promise<AskReadResult>;
}

/** Hits per question at most (the search's `k`); more is a caller bug. */
export const MAX_READ_HITS = 16;

const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const linesOf = (bytes: Uint8Array): string[] | null => {
  try {
    return strictUtf8.decode(bytes).split("\n");
  } catch {
    return null;
  }
};

export const createAskExcerptReader = (options: {
  readonly forge: Pick<CodeReader, "openCode">;
}): AskExcerptReader => ({
  read: async (target, hits) => {
    if (
      !isId(target.installationId) ||
      !isId(target.repositoryId) ||
      typeof target.indexedSha !== "string" ||
      !SHA.test(target.indexedSha) ||
      hits.length > MAX_READ_HITS ||
      hits.some((h) => !SHA.test(h.blobSha) || !(h.startLine >= 1) || !(h.endLine >= h.startLine))
    ) {
      throw new Error("ask excerpts: invalid target");
    }
    if (hits.length === 0) return { kind: "ok", sources: [], blobs: 0 };
    try {
      const session = await options.forge.openCode({
        installationId: target.installationId,
        repositoryId: target.repositoryId,
      });
      if (session === null) return { kind: "not_found" };
      try {
        let usable = hits.map(() => true);
        if (target.verifyAtCommit) {
          const tree = await session.readTree(target.indexedSha);
          const atCommit = new Map((tree?.entries ?? []).map((e) => [e.path, e.blobSha]));
          usable = hits.map((h) => atCommit.get(h.path) === h.blobSha);
        }
        const texts = new Map<string, string[] | null>();
        for (const [i, hit] of hits.entries()) {
          if (!usable[i] || texts.has(hit.blobSha)) continue;
          const blob = await session.readBlob(hit.blobSha, {
            maxBytes: INDEX_LIMITS.maxFileBytes,
          });
          texts.set(hit.blobSha, blob.kind === "ok" ? linesOf(blob.bytes) : null);
        }
        const sources = hits.map((hit, i): AskExcerptSource | null => {
          const lines = usable[i] ? texts.get(hit.blobSha) : null;
          if (lines === null || lines === undefined || hit.endLine > lines.length) return null;
          return {
            path: hit.path,
            startLine: hit.startLine,
            endLine: hit.endLine,
            lines: lines.slice(hit.startLine - 1, hit.endLine),
          };
        });
        return { kind: "ok", sources, blobs: texts.size };
      } finally {
        await session.close();
      }
    } catch (error) {
      if (error instanceof ForgeReadError) return { kind: "forge_failed", code: error.code };
      throw error;
    }
  },
});
