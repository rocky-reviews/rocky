import { INDEX_VECTOR_DIMENSIONS, type EmbeddingSpace } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import {
  approveCodeIndex,
  beginCodeIndexRun,
  CodeIndexLeaseLostError,
  codeIndexState,
  enqueueCodeIndex,
  finishCodeIndex,
  loadCodeIndexTarget,
  removeIndexedFiles,
  renewCodeIndexLease,
  reusableVectors,
  searchCodeChunks,
  storedIndexFiles,
  writeIndexedFiles,
  type ClaimedCodeIndex,
  type IndexedFileWrite,
} from "./code-index.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P9-1 (migration 0022, ADR 0040): the repository index as Postgres stores it. The claim is the
 * worker's alone and runs one index per org at a time; every write checks the lease; vectors are
 * stored per embedding space and searched only within one repository, one space and one org.
 */

let pgs: TestPostgres;
let app: Db;
let worker: Db;
let superuser: pg.Pool;
let A: SeededOrg;
let B: SeededOrg;

const SPACE: EmbeddingSpace = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 4,
};
const OTHER: EmbeddingSpace = { provider: "voyage", model: "voyage-code-3", dimensions: 4 };

beforeAll(async () => {
  pgs = await startPostgres();
  app = createDb({ connectionString: pgs.appUrl, max: 2 });
  worker = createDb({ connectionString: pgs.workerUrl, max: 2 });
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 1 }).on("error", ignoreIdleError);
  A = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 91 }));
  B = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 92 }));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await worker?.close();
  await superuser?.end();
  await pgs?.stop();
});

// Each test starts from an empty index (the fixture rows included) and no queue.
beforeEach(async () => {
  await superuser.query("delete from code_files");
  await superuser.query("delete from code_indexes");
});

const hash = (n: number) => n.toString(16).padStart(64, "0");

const file = (path: string, vectors: number[][], blob = "a"): IndexedFileWrite => ({
  path,
  blobSha: blob.repeat(40),
  language: "typescript",
  status: "indexed",
  chunks: vectors.map((vector, ordinal) => ({
    ordinal,
    startLine: ordinal * 10 + 1,
    endLine: ordinal * 10 + 9,
    kind: "function_declaration",
    contentSha256: hash(path.length * 100 + ordinal),
    vector,
  })),
});

const claimOne = async (org: SeededOrg): Promise<ClaimedCodeIndex> => {
  await app.withOrg(org.orgId, (tx) => enqueueCodeIndex(tx, org.repoId, null));
  const claims = await worker.claimCodeIndexes({ limit: 5, leaseSeconds: 600 });
  const claim = claims.find((c) => c.orgId === org.orgId);
  if (claim === undefined) throw new Error("expected a claim");
  return claim;
};

describe("enqueue and claim", () => {
  it("queues one row per repository; a later push bumps its generation and commit", async () => {
    const first = await app.withOrg(A.orgId, (tx) =>
      enqueueCodeIndex(tx, A.repoId, "1".repeat(40)),
    );
    const second = await app.withOrg(A.orgId, (tx) =>
      enqueueCodeIndex(tx, A.repoId, "2".repeat(40)),
    );
    expect(second.indexId).toBe(first.indexId);
    expect(second.generation).toBe(first.generation + 1);
    const state = await app.withOrg(A.orgId, (tx) => codeIndexState(tx, A.repoId));
    expect(state).toMatchObject({
      status: "queued",
      requestedSha: "2".repeat(40),
      indexedSha: null,
    });
  });

  it("hands out at most one running index per org, leased, and only to the worker", async () => {
    await app.withOrg(A.orgId, (tx) => enqueueCodeIndex(tx, A.repoId, null));
    await app.withOrg(B.orgId, (tx) => enqueueCodeIndex(tx, B.repoId, null));
    await expect(app.claimCodeIndexes({ limit: 5, leaseSeconds: 600 })).rejects.toThrow();
    const claims = await worker.claimCodeIndexes({ limit: 5, leaseSeconds: 600 });
    expect(claims.map((c) => c.orgId).sort()).toEqual([A.orgId, B.orgId].sort());
    for (const c of claims) {
      expect(c.attempts).toBe(1);
      expect(c.leaseUntil.getTime()).toBeGreaterThan(Date.now());
    }
    expect(await worker.claimCodeIndexes({ limit: 5, leaseSeconds: 600 })).toEqual([]);
  });

  it("reclaims an expired lease, and fails a row whose attempts are used up", async () => {
    const claim = await claimOne(A);
    await superuser.query("update code_indexes set lease_until = now() - interval '1 second'");
    const again = await worker.claimCodeIndexes({ limit: 5, leaseSeconds: 600 });
    expect(again.map((c) => c.indexId)).toEqual([claim.indexId]);
    expect(again[0]?.attempts).toBe(2);
    await superuser.query(
      "update code_indexes set attempts = 5, lease_until = now() - interval '1 second'",
    );
    expect(await worker.claimCodeIndexes({ limit: 5, leaseSeconds: 600 })).toEqual([]);
    const state = await app.withOrg(A.orgId, (tx) => codeIndexState(tx, A.repoId));
    expect(state).toMatchObject({ status: "failed", errorCode: "lease_expired" });
  });

  it("a push while a run is going keeps it running and queues it again when it finishes", async () => {
    const claim = await claimOne(A);
    await app.withOrg(A.orgId, (tx) => enqueueCodeIndex(tx, A.repoId, "3".repeat(40)));
    expect((await app.withOrg(A.orgId, (tx) => codeIndexState(tx, A.repoId)))?.status).toBe(
      "running",
    );
    const finished = await app.withOrg(A.orgId, (tx) =>
      finishCodeIndex(tx, claim, {
        kind: "done",
        indexedSha: "2".repeat(40),
        spentTokens: 0,
      }),
    );
    expect(finished).toBe("queued");
    expect(await app.withOrg(A.orgId, (tx) => codeIndexState(tx, A.repoId))).toMatchObject({
      status: "queued",
      indexedSha: "2".repeat(40),
      requestedSha: "3".repeat(40),
    });
  });
});

describe("a run: lease-checked writes, vectors per space, removal", () => {
  it("loads its target, writes files with their chunks and vectors, and lists what it holds", async () => {
    const claim = await claimOne(A);
    const target = await app.withOrg(A.orgId, (tx) => loadCodeIndexTarget(tx, claim));
    expect(target).toMatchObject({
      repoId: A.repoId,
      forgeRepoId: 2001,
      installationId: 91,
      defaultBranch: "main",
      requestedSha: null,
      space: null,
    });
    expect(await app.withOrg(A.orgId, (tx) => beginCodeIndexRun(tx, claim, SPACE))).toEqual({
      reset: true,
    });
    const written = await app.withOrg(A.orgId, (tx) =>
      writeIndexedFiles(tx, claim, A.repoId, SPACE, [
        file("src/a.ts", [
          [1, 0, 0, 0],
          [0, 1, 0, 0],
        ]),
        {
          path: "img/x.ts",
          blobSha: "b".repeat(40),
          language: "typescript",
          status: "skipped",
          skipReason: "binary",
          chunks: [],
        },
      ]),
    );
    expect(written).toEqual({ files: 2, chunks: 2 });
    expect(
      (await app.withOrg(A.orgId, (tx) => storedIndexFiles(tx, A.repoId))).sort((x, y) =>
        x.path.localeCompare(y.path),
      ),
    ).toEqual([
      { path: "img/x.ts", blobSha: "b".repeat(40) },
      { path: "src/a.ts", blobSha: "a".repeat(40) },
    ]);
    // Stored at the index width, zero-padded, with the space on the row.
    const { rows } = await superuser.query<{ n: number; provider: string; dims: number }>(
      `select vector_dims(embedding) as n, provider, dimensions as dims from embeddings
        where code_chunk_id is not null limit 1`,
    );
    expect(rows[0]).toEqual({ n: INDEX_VECTOR_DIMENSIONS, provider: "openai", dims: 4 });
  });

  it("rewrites a changed file, removes a deleted one, and cascades to chunks and vectors", async () => {
    const claim = await claimOne(A);
    await app.withOrg(A.orgId, async (tx) => {
      await beginCodeIndexRun(tx, claim, SPACE);
      await writeIndexedFiles(tx, claim, A.repoId, SPACE, [
        file("src/a.ts", [[1, 0, 0, 0]]),
        file("src/b.ts", [[0, 1, 0, 0]]),
      ]);
      await writeIndexedFiles(tx, claim, A.repoId, SPACE, [
        file(
          "src/a.ts",
          [
            [0, 0, 1, 0],
            [0, 0, 0, 1],
          ],
          "c",
        ),
      ]);
      expect(await removeIndexedFiles(tx, claim, A.repoId, ["src/b.ts", "src/none.ts"])).toBe(1);
    });
    const counts = await superuser.query<{ files: string; chunks: string; vectors: string }>(
      `select (select count(*) from code_files)::text as files,
              (select count(*) from code_chunks)::text as chunks,
              (select count(*) from embeddings where code_chunk_id is not null)::text as vectors`,
    );
    expect(counts.rows[0]).toEqual({ files: "1", chunks: "2", vectors: "2" });
  });

  it("reuses a stored vector by the chunk's content hash, within the same space only", async () => {
    const claim = await claimOne(A);
    const written = file("src/a.ts", [[0.5, 0.5, 0.5, 0.5]]);
    const contentHash = written.chunks[0]!.contentSha256;
    await app.withOrg(A.orgId, async (tx) => {
      await beginCodeIndexRun(tx, claim, SPACE);
      await writeIndexedFiles(tx, claim, A.repoId, SPACE, [written]);
    });
    const same = await app.withOrg(A.orgId, (tx) =>
      reusableVectors(tx, A.repoId, SPACE, [contentHash, hash(999)]),
    );
    expect([...same.keys()]).toEqual([contentHash]);
    expect(same.get(contentHash)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(
      (await app.withOrg(A.orgId, (tx) => reusableVectors(tx, A.repoId, OTHER, [contentHash])))
        .size,
    ).toBe(0);
    // Another org never sees it.
    expect(
      (await app.withOrg(B.orgId, (tx) => reusableVectors(tx, A.repoId, SPACE, [contentHash])))
        .size,
    ).toBe(0);
  });

  it("refuses writes once the lease is lost", async () => {
    const claim = await claimOne(A);
    await superuser.query("update code_indexes set lease_id = gen_random_uuid()");
    await expect(
      app.withOrg(A.orgId, (tx) =>
        writeIndexedFiles(tx, claim, A.repoId, SPACE, [file("src/a.ts", [[1, 0, 0, 0]])]),
      ),
    ).rejects.toBeInstanceOf(CodeIndexLeaseLostError);
    expect(await app.withOrg(A.orgId, (tx) => renewCodeIndexLease(tx, claim, 600))).toBe(false);
    expect(
      await app.withOrg(A.orgId, (tx) =>
        finishCodeIndex(tx, claim, { kind: "failed", errorCode: "forge_timeout" }),
      ),
    ).toBe("lost");
  });

  it("a new embedding space empties the index first (switching model means re-indexing)", async () => {
    const claim = await claimOne(A);
    await app.withOrg(A.orgId, async (tx) => {
      await beginCodeIndexRun(tx, claim, SPACE);
      await writeIndexedFiles(tx, claim, A.repoId, SPACE, [file("src/a.ts", [[1, 0, 0, 0]])]);
      await finishCodeIndex(tx, claim, {
        kind: "done",
        indexedSha: "4".repeat(40),
        spentTokens: 5,
      });
    });
    const next = await claimOne(A);
    expect(await app.withOrg(A.orgId, (tx) => beginCodeIndexRun(tx, next, SPACE))).toEqual({
      reset: false,
    });
    expect(await app.withOrg(A.orgId, (tx) => beginCodeIndexRun(tx, next, OTHER))).toEqual({
      reset: true,
    });
    expect(await app.withOrg(A.orgId, (tx) => storedIndexFiles(tx, A.repoId))).toEqual([]);
    expect(await app.withOrg(A.orgId, (tx) => codeIndexState(tx, A.repoId))).toMatchObject({
      indexedSha: null,
      space: OTHER,
    });
  });

  it("stops over the token limit and runs again once a person approves", async () => {
    const claim = await claimOne(A);
    expect(
      await app.withOrg(A.orgId, (tx) =>
        finishCodeIndex(tx, claim, {
          kind: "over_limit",
          estimatedTokens: 9000,
          limitTokens: 5000,
        }),
      ),
    ).toBe("over_limit");
    expect(await app.withOrg(A.orgId, (tx) => codeIndexState(tx, A.repoId))).toMatchObject({
      status: "over_limit",
      estimatedTokens: 9000,
      limitTokens: 5000,
    });
    expect(
      await app.withOrg(A.orgId, (tx) =>
        approveCodeIndex(tx, A.repoId, { type: "system", id: "test" }),
      ),
    ).toBe(true);
    const again = await worker.claimCodeIndexes({ limit: 5, leaseSeconds: 600 });
    const target = await app.withOrg(A.orgId, (tx) => loadCodeIndexTarget(tx, again[0]!));
    expect(target?.approvedTokens).toBe(9000);
  });

  it("retries later with a backoff, keeping what was written", async () => {
    const claim = await claimOne(A);
    expect(
      await app.withOrg(A.orgId, (tx) =>
        finishCodeIndex(tx, claim, {
          kind: "retry",
          errorCode: "forge_http_502",
          delaySeconds: 60,
        }),
      ),
    ).toBe("queued");
    // Not claimable before its backoff.
    expect(await worker.claimCodeIndexes({ limit: 5, leaseSeconds: 600 })).toEqual([]);
  });
});

describe("searchCodeChunks: the tenant filter", () => {
  const seed = async (org: SeededOrg, space: EmbeddingSpace, vectors: Record<string, number[]>) => {
    const claim = await claimOne(org);
    await app.withOrg(org.orgId, async (tx) => {
      await beginCodeIndexRun(tx, claim, space);
      await writeIndexedFiles(
        tx,
        claim,
        org.repoId,
        space,
        Object.entries(vectors).map(([path, vector]) => file(path, [vector])),
      );
      await finishCodeIndex(tx, claim, {
        kind: "done",
        indexedSha: "5".repeat(40),
        spentTokens: 1,
      });
    });
  };

  it("returns the top-k chunks of one repository with path and line range, nearest first", async () => {
    await seed(A, SPACE, {
      "src/near.ts": [1, 0.1, 0, 0],
      "src/mid.ts": [0.6, 0.8, 0, 0],
      "src/far.ts": [0, 0, 0, 1],
    });
    for (const mode of ["exact", "approximate", "auto"] as const) {
      const hits = await app.withOrg(A.orgId, (tx) =>
        searchCodeChunks(tx, { repoId: A.repoId, space: SPACE, vector: [1, 0, 0, 0], k: 2, mode }),
      );
      expect(
        hits.map((h) => h.path),
        mode,
      ).toEqual(["src/near.ts", "src/mid.ts"]);
      expect(hits[0]).toMatchObject({
        path: "src/near.ts",
        startLine: 1,
        endLine: 9,
        kind: "function_declaration",
        blobSha: "a".repeat(40),
      });
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
      expect(hits[0]!.score).toBeLessThanOrEqual(1);
    }
  });

  it("never returns another org's, another repository's or another space's vectors", async () => {
    await seed(A, SPACE, { "src/mine.ts": [0, 1, 0, 0] });
    await seed(B, SPACE, { "src/theirs.ts": [1, 0, 0, 0] });
    const fromA = await app.withOrg(A.orgId, (tx) =>
      searchCodeChunks(tx, { repoId: A.repoId, space: SPACE, vector: [1, 0, 0, 0], k: 10 }),
    );
    expect(fromA.map((h) => h.path)).toEqual(["src/mine.ts"]);
    // B's repository id from inside A's transaction: nothing.
    expect(
      await app.withOrg(A.orgId, (tx) =>
        searchCodeChunks(tx, { repoId: B.repoId, space: SPACE, vector: [1, 0, 0, 0], k: 10 }),
      ),
    ).toEqual([]);
    expect(
      await app.withOrg(A.orgId, (tx) =>
        searchCodeChunks(tx, { repoId: A.repoId, space: OTHER, vector: [1, 0, 0, 0], k: 10 }),
      ),
    ).toEqual([]);
  });

  it("refuses a query vector of the wrong width and an unbounded k", async () => {
    await expect(
      app.withOrg(A.orgId, (tx) =>
        searchCodeChunks(tx, { repoId: A.repoId, space: SPACE, vector: [1, 0], k: 2 }),
      ),
    ).rejects.toThrow();
    await expect(
      app.withOrg(A.orgId, (tx) =>
        searchCodeChunks(tx, { repoId: A.repoId, space: SPACE, vector: [1, 0, 0, 0], k: 500 }),
      ),
    ).rejects.toThrow();
  });
});
