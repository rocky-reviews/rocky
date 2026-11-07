import { randomUUID } from "node:crypto";
import {
  embeddingInput,
  LlmCallError,
  type CodeReader,
  type EmbeddingSpace,
  type Forge,
  type LlmRoles,
  type OrgId,
} from "@rocky-reviews/core";
import {
  approveCodeIndex,
  codeIndexState,
  createDb,
  enqueueCodeIndex,
  searchCodeChunks,
  type ClaimedCodeIndex,
  type Db,
} from "@rocky-reviews/db";
import {
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  startPostgres,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import {
  createGitHubForge,
  createGitHubWebhookIngress,
  githubEndpoints,
  parseGitHubAppAuth,
} from "@rocky-reviews/forge-github";
import {
  fakeGitHubApi,
  FIXTURE_APP_ID,
  installationPayload,
  pushPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
  testAppKeys,
  type FakeGitHubApi,
} from "@rocky-reviews/forge-github/testing";
import {
  createTreeSitterChunker,
  deterministicEmbedder,
  prepareFile,
  type DeterministicEmbedder,
  type FileChunker,
} from "@rocky-reviews/indexer";
import { llmConfigFromEnv, usageTargetsFor, type LlmUsageTargets } from "@rocky-reviews/llm";
import { createLogger } from "@rocky-reviews/log";
import { buildApp } from "@rocky-reviews/server/app";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppCheck, type AppCheck } from "./app-check.js";
import { runCodeIndex, sizeTokens, type CodeIndexDeps } from "./code-index.js";
import { drainInstallationEvents, drainRepositoryEvents } from "./inbox.js";

/**
 * P9-1 end to end (ADR 0040): a signed `push` webhook into `POST /webhooks/github` → the inbox →
 * the worker's repository lane (installation re-checked, index queued) → the index lane's claim
 * → the run: the tree read on a `contents: read` token scoped to the repository, changed blobs
 * fetched (or one archive), chunked by tree-sitter, embedded by a deterministic fake (no
 * provider is called), stored under RLS with the space on every vector → search within one
 * repository. Then a second push: only its changed files are read, deleted ones removed.
 */

const HEAD_1 = "1".repeat(40);
const HEAD_2 = "2".repeat(40);
const HEAD_3 = "3".repeat(40);
/** Only the code contains it: never the database, never a log. */
const MARKER = "codeOnlyMarker_7f3a";

const A_TS = `import { db } from "./db";

/** Loads one invoice. */
export function loadInvoice(id: string) {
  const row = db.find(id);
  if (row === undefined) throw new Error("missing");
  return row;
}

export class InvoiceService {
  constructor(private readonly prefix: string) {}

  format(id: string): string {
    const ${MARKER} = this.prefix + id;
    return ${MARKER}.toUpperCase();
  }
}
`;
const A_TS_CHANGED = A_TS.replace("toUpperCase()", "toLowerCase()");
const B_PY = `def total(items):
    result = 0
    for item in items:
        result += item.price
    return result
`;
const C_GO = `package main

func Add(a int, b int) int {
\tsum := a + b
\treturn sum
}
`;
const FILES_1: Record<string, string | Uint8Array> = {
  "src/a.ts": A_TS,
  "src/b.py": B_PY,
  "README.md": "# Invoices\n\nHow invoices are loaded and formatted.\n",
  "vendor/lib.js": "export const vendored = 1;\n",
  "dist/app.min.js": "var a=1;\n",
  "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
  "src/binary.ts": new Uint8Array([0x65, 0x78, 0, 0, 0x70]),
};

const without = (files: Record<string, string | Uint8Array>, path: string) =>
  Object.fromEntries(Object.entries(files).filter(([p]) => p !== path));

let pgs: TestPostgres;
let superuser: pg.Pool;
let serverDb: Db;
let workerDb: Db;
let app: ReturnType<typeof buildApp>;
let github: FakeGitHubApi;
let forge: Forge & CodeReader;
let appCheck: AppCheck;
let chunker: FileChunker;
let embedder: DeterministicEmbedder;
let usageTargets: LlmUsageTargets;
let space: EmbeddingSpace;
const keys = testAppKeys();
const logLines: string[] = [];
const log = createLogger("code-index-e2e", {
  level: "debug",
  destination: { write: (line: string) => void logLines.push(line) },
});
let nextInstallation = 9100;
let nextRepository = 910;

const post = async (event: string, payload: unknown) => {
  const d = signedDelivery(event, payload);
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: d.headers,
    payload: d.body,
  });
  return { status: response.statusCode, deliveryId: d.headers["x-github-delivery"]! };
};

const tenant = async () => {
  const installationId = nextInstallation++;
  const accountId = installationId + 100_000;
  const repositoryId = nextRepository++;
  const login = `acct-${installationId}`;
  github.install(installationId, { id: accountId, login, type: "Organization" });
  github.addRepository(installationId, { id: repositoryId, fullName: `${login}/api` });
  await post("installation", installationPayload("created", { installationId, accountId, login }));
  await drainInstallationEvents({
    db: workerDb,
    forge,
    appCheck,
    log,
    newOrgId: () => randomUUID() as OrgId,
    batchSize: 10,
  });
  const { rows } = await superuser.query<{ id: OrgId }>(
    "select id from orgs where installation_id = $1",
    [installationId],
  );
  return { installationId, repositoryId, orgId: rows[0]!.id };
};
type Tenant = Awaited<ReturnType<typeof tenant>>;

const roles = (): LlmRoles => ({
  completion: () => {
    throw new Error("indexing makes no completion");
  },
  embedding: () => embedder,
});

const deps = (overrides: Partial<CodeIndexDeps> = {}): CodeIndexDeps => ({
  db: workerDb,
  forge,
  llm: roles(),
  usageTargets,
  space,
  chunker,
  log,
  tokenLimit: 1_000_000,
  ...overrides,
});

/** A push reaches the default branch: webhook, inbox, the repository lane. */
const push = async (t: Tenant, head: string, indexing = true) => {
  const { status, deliveryId } = await post(
    "push",
    pushPayload({ installationId: t.installationId, repositoryId: t.repositoryId, after: head }),
  );
  expect(status).toBe(202);
  const report = await drainRepositoryEvents({
    db: workerDb,
    forge,
    appCheck,
    log,
    batchSize: 10,
    indexing,
  });
  expect(report.processed).toBe(1);
  const { rows } = await superuser.query<{ outcome: string }>(
    "select outcome from app.webhook_deliveries where delivery_id = $1",
    [deliveryId],
  );
  return rows[0]?.outcome;
};

/** Asks for a run without a push (the inbox would take the same delivery as a duplicate). */
const requeue = async (t: Tenant): Promise<void> => {
  const repoId = await repoIdOf(t);
  await workerDb.withOrg(t.orgId, (tx) => enqueueCodeIndex(tx, repoId, null));
};

const claim = async (t: Tenant): Promise<ClaimedCodeIndex> => {
  const claims = await workerDb.claimCodeIndexes({ limit: 5, leaseSeconds: 600 });
  const mine = claims.find((c) => c.orgId === t.orgId);
  if (mine === undefined) throw new Error("expected a claim");
  return mine;
};

const repoIdOf = async (t: Tenant): Promise<string> =>
  (
    await superuser.query<{ id: string }>(
      "select id from repos where org_id = $1 and forge_repo_id = $2",
      [t.orgId, t.repositoryId],
    )
  ).rows[0]!.id;

const indexedPaths = async (t: Tenant) =>
  (
    await superuser.query<{ path: string; status: string; skip_reason: string | null }>(
      `select f.path, f.status, f.skip_reason from code_files f
         join repos r on r.org_id = f.org_id and r.id = f.repo_id
        where f.org_id = $1 and r.forge_repo_id = $2 order by f.path collate "C"`,
      [t.orgId, t.repositoryId],
    )
  ).rows;

const blobReads = (t: Tenant) =>
  github.requests.filter((r) => r.path.startsWith(`/repos/acct-${t.installationId}/api/git/blobs/`))
    .length;

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  serverDb = createDb({ connectionString: pgs.appUrl, max: 4 });
  workerDb = createDb({ connectionString: pgs.workerUrl, max: 4 });
  app = buildApp({
    checkDatabase: () => Promise.resolve(true),
    webhooks: {
      ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }),
      inbox: { record: (d) => serverDb.recordWebhookDelivery(d) },
    },
  });
  github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
  forge = createGitHubForge({
    auth: parseGitHubAppAuth({ appId: String(FIXTURE_APP_ID), privateKey: keys.privateKeyPem }),
    api: githubEndpoints({}).api,
    clock: { now: () => new Date() },
    fetch: github.fetch,
  });
  appCheck = createAppCheck({ forge, clock: { now: () => new Date() }, log });
  chunker = await createTreeSitterChunker();
  embedder = deterministicEmbedder({ dimensions: 16 });
  space = { provider: "fake", model: embedder.model, dimensions: 16 };
  usageTargets = {
    ...usageTargetsFor(llmConfigFromEnv({})),
    embed: { provider: "fake", model: embedder.model },
  };
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await serverDb?.close();
  await workerDb?.close();
  await superuser?.end();
  await pgs?.stop();
});

describe("acceptance: a push indexes the repository, the next push re-indexes only what changed", () => {
  it("full index, search within the repository, then an incremental push", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, FILES_1, { branch: "main" });
    expect(await push(t, HEAD_1)).toBe("index_queued");

    const first = await runCodeIndex(deps(), await claim(t));
    expect(first).toMatchObject({ outcome: "done", fullRun: true, filesRemoved: 0 });
    expect(first.chunksEmbedded).toBeGreaterThanOrEqual(3);
    // Vendored, generated and image paths are never fetched; content-skipped files are kept as
    // skipped so the next run does not fetch them again.
    expect(await indexedPaths(t)).toEqual([
      { path: "README.md", status: "indexed", skip_reason: null },
      { path: "src/a.ts", status: "indexed", skip_reason: null },
      { path: "src/b.py", status: "indexed", skip_reason: null },
      { path: "src/binary.ts", status: "skipped", skip_reason: "binary" },
    ]);
    expect(blobReads(t)).toBe(4);
    // The token was scoped to the one repository, contents read only.
    expect(github.tokens.mints.at(-1)).toEqual({
      installationId: t.installationId,
      body: { repository_ids: [t.repositoryId], permissions: { contents: "read" } },
    });

    const repoId = await repoIdOf(t);
    const state = await workerDb.withOrg(t.orgId, (tx) => codeIndexState(tx, repoId));
    expect(state).toMatchObject({
      status: "done",
      indexedSha: HEAD_1,
      space,
      filesIndexed: 3,
      chunksIndexed: first.chunksWritten,
    });
    // Metered per org in llm_usage, role embed, provider and model of the space.
    const usage = await superuser.query<{ role: string; provider: string; n: string }>(
      `select role, provider, count(*)::text as n from llm_usage where org_id = $1
        group by role, provider`,
      [t.orgId],
    );
    expect(usage.rows).toEqual([{ role: "embed", provider: "fake", n: expect.any(String) }]);

    // Search: the chunk whose text is the query comes first, with its path and line range.
    const prepared = await prepareFile(chunker, "src/a.ts", new TextEncoder().encode(A_TS));
    if (prepared.kind !== "chunks") throw new Error("expected chunks");
    const target = prepared.chunks.find((c) => c.text.includes("loadInvoice"))!;
    const query = await embedder.embed({ inputs: [embeddingInput("src/a.ts", target)] });
    const hits = await workerDb.withOrg(t.orgId, (tx) =>
      searchCodeChunks(tx, { repoId, space, vector: query.vectors[0]!, k: 3 }),
    );
    expect(hits[0]).toMatchObject({
      path: "src/a.ts",
      startLine: target.startLine,
      endLine: target.endLine,
    });
    expect(hits[0]!.score).toBeCloseTo(1, 5);

    // Push 2: a.ts changed (one method), b.py deleted, c.go added.
    const kept = without(FILES_1, "src/b.py");
    github.putCode(
      t.repositoryId,
      HEAD_2,
      { ...kept, "src/a.ts": A_TS_CHANGED, "src/c.go": C_GO },
      { branch: "main" },
    );
    const readsBefore = blobReads(t);
    const started = Date.now();
    expect(await push(t, HEAD_2)).toBe("index_queued");
    const second = await runCodeIndex(deps(), await claim(t));
    const elapsedMs = Date.now() - started;
    expect(second).toMatchObject({ outcome: "done", fullRun: false, filesRemoved: 1 });
    // Only the two changed files were read; the unchanged chunks of a.ts kept their vectors.
    expect(blobReads(t) - readsBefore).toBe(2);
    expect(second.chunksReused).toBeGreaterThanOrEqual(1);
    expect(second.chunksEmbedded).toBeLessThan(first.chunksEmbedded);
    expect(elapsedMs).toBeLessThan(30_000);
    expect((await indexedPaths(t)).map((f) => f.path)).toEqual([
      "README.md",
      "src/a.ts",
      "src/binary.ts",
      "src/c.go",
    ]);

    // Asked again at the same head: nothing to do, nothing read.
    await requeue(t);
    const readsSettled = blobReads(t);
    expect(await runCodeIndex(deps(), await claim(t))).toMatchObject({
      outcome: "done",
      chunksEmbedded: 0,
    });
    expect(blobReads(t)).toBe(readsSettled);

    // No code in the database, no code or paths in the logs.
    const dump = await superuser.query<{ dump: string }>(
      `select (select coalesce(json_agg(f), '[]') from code_files f)::text
           || (select coalesce(json_agg(c), '[]') from code_chunks c)::text
           || (select coalesce(json_agg(i), '[]') from code_indexes i)::text
           || (select coalesce(json_agg(u), '[]') from llm_usage u)::text as dump`,
    );
    expect(dump.rows[0]!.dump).not.toContain(MARKER);
    const logs = logLines.join("\n");
    expect(logs).not.toContain(MARKER);
    expect(logs).not.toContain("src/a.ts");
    expect(logs).not.toContain("loadInvoice");
  });
});

describe("the index lane's edges", () => {
  it("with indexing off, a push is finished without reading GitHub", async () => {
    const t = await tenant();
    const before = github.requests.length;
    expect(await push(t, HEAD_1, false)).toBe("indexing_off");
    expect(github.requests.length).toBe(before);
    expect(await workerDb.claimCodeIndexes({ limit: 5, leaseSeconds: 600 })).toEqual([]);
  });

  it("over the token limit nothing is fetched or embedded until a person approves", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, FILES_1, { branch: "main" });
    await push(t, HEAD_1);
    const calls = embedder.calls;
    const held = await runCodeIndex(deps({ tokenLimit: 10 }), await claim(t));
    expect(held).toMatchObject({ outcome: "over_limit", chunksEmbedded: 0 });
    expect(blobReads(t)).toBe(0);
    expect(embedder.calls).toBe(calls);
    const repoId = await repoIdOf(t);
    expect(
      await workerDb.withOrg(t.orgId, (tx) =>
        approveCodeIndex(tx, repoId, { type: "system", id: "e2e" }),
      ),
    ).toBe(true);
    expect(await runCodeIndex(deps({ tokenLimit: 10 }), await claim(t))).toMatchObject({
      outcome: "done",
    });
  });

  it("many changed files come from one archive, downloaded without the token", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, FILES_1, { branch: "main" });
    await push(t, HEAD_1);
    const archives = github.archiveRequests.length;
    const run = await runCodeIndex(deps({ blobFetchMax: 0 }), await claim(t));
    expect(run).toMatchObject({ outcome: "done", filesWritten: 4 });
    expect(blobReads(t)).toBe(0);
    expect(github.archiveRequests.slice(archives)).toEqual([{ authorized: false }]);
  });

  it("a truncated tree listing is replaced by the archive, removals included", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, FILES_1, { branch: "main" });
    await push(t, HEAD_1);
    await runCodeIndex(deps(), await claim(t));
    const kept = without(FILES_1, "src/b.py");
    github.putCode(
      t.repositoryId,
      HEAD_3,
      { ...kept, "src/a.ts": A_TS_CHANGED },
      { branch: "main", truncated: true },
    );
    await push(t, HEAD_3);
    const run = await runCodeIndex(deps(), await claim(t));
    expect(run).toMatchObject({ outcome: "done", filesRemoved: 1, filesWritten: 1 });
    expect((await indexedPaths(t)).map((f) => f.path)).toEqual([
      "README.md",
      "src/a.ts",
      "src/binary.ts",
    ]);
  });

  it("another embedding model empties the index and indexes in full (never mixed spaces)", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, FILES_1, { branch: "main" });
    await push(t, HEAD_1);
    await runCodeIndex(deps(), await claim(t));
    await requeue(t);
    const other: EmbeddingSpace = { ...space, model: "deterministic-other" };
    const run = await runCodeIndex(deps({ space: other }), await claim(t));
    expect(run).toMatchObject({ outcome: "done", fullRun: true, chunksReused: 0 });
    const spaces = await superuser.query<{ model: string }>(
      `select distinct e.model from embeddings e where e.org_id = $1 and e.code_chunk_id is not null`,
      [t.orgId],
    );
    expect(spaces.rows).toEqual([{ model: "deterministic-other" }]);
  });

  it("a repository the installation lost is a failed run (no token is minted)", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, FILES_1, { branch: "main" });
    await push(t, HEAD_1);
    const c = await claim(t);
    github.removeRepository(t.repositoryId);
    expect(await runCodeIndex(deps(), c)).toMatchObject({
      outcome: "failed",
      errorCode: "repository_inaccessible",
    });
  });

  it("GitHub failing after the mint is retried later, and the token is revoked", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, FILES_1, { branch: "main" });
    await push(t, HEAD_1);
    const c = await claim(t);
    const revoked = github.tokens.revoked;
    github.failRoute("tree", 502);
    expect(await runCodeIndex(deps(), c)).toMatchObject({
      outcome: "retry",
      errorCode: "forge_http_502",
    });
    expect(github.tokens.revoked).toBe(revoked + 1);
  });

  it("the embedding provider failing is retried later, and the token is revoked", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, FILES_1, { branch: "main" });
    await push(t, HEAD_1);
    const c = await claim(t);
    const revoked = github.tokens.revoked;
    const failing: LlmRoles = {
      completion: () => {
        throw new Error("indexing makes no completion");
      },
      embedding: () => ({
        embed: () => Promise.reject(new LlmCallError("server_error")),
      }),
    };
    expect(await runCodeIndex(deps({ llm: failing }), c)).toMatchObject({
      outcome: "retry",
      errorCode: "llm_server_error",
      chunksWritten: 0,
    });
    expect(github.tokens.revoked).toBe(revoked + 1);
  });

  it("a truncated listing on a full run is bounded by the repository's size before any download", async () => {
    const t = await tenant();
    // 10 000 KiB is about 3.4M tokens at 3 characters a token (CHARS_PER_TOKEN): over a 1M limit.
    github.putCode(t.repositoryId, HEAD_1, FILES_1, {
      branch: "main",
      truncated: true,
      sizeKb: 10_000,
    });
    await push(t, HEAD_1);
    const archives = github.archiveRequests.length;
    const calls = embedder.calls;
    expect(await runCodeIndex(deps(), await claim(t))).toMatchObject({
      outcome: "over_limit",
      chunksEmbedded: 0,
    });
    expect(github.archiveRequests.length).toBe(archives);
    expect(embedder.calls).toBe(calls);
    const repoId = await repoIdOf(t);
    expect(await workerDb.withOrg(t.orgId, (tx) => codeIndexState(tx, repoId))).toMatchObject({
      status: "over_limit",
      estimatedTokens: sizeTokens(10_000),
      limitTokens: 1_000_000,
    });
    // Approved, it runs from the archive.
    await workerDb.withOrg(t.orgId, (tx) =>
      approveCodeIndex(tx, repoId, { type: "system", id: "e2e" }),
    );
    expect(await runCodeIndex(deps(), await claim(t))).toMatchObject({
      outcome: "done",
      fullRun: true,
    });
    expect(github.archiveRequests.length).toBe(archives + 1);
  });

  it("a truncated listing of unknown size waits for a person on a full run", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, FILES_1, {
      branch: "main",
      truncated: true,
      sizeKb: null,
    });
    await push(t, HEAD_1);
    const archives = github.archiveRequests.length;
    expect(await runCodeIndex(deps(), await claim(t))).toMatchObject({ outcome: "over_limit" });
    expect(github.archiveRequests.length).toBe(archives);
  });
});

describe("vector reuse is keyed by the exact embedded input (path and text)", () => {
  it("a renamed file's chunks are embedded again, under the new path", async () => {
    const t = await tenant();
    github.putCode(t.repositoryId, HEAD_1, { "src/a.ts": A_TS }, { branch: "main" });
    await push(t, HEAD_1);
    const first = await runCodeIndex(deps(), await claim(t));
    expect(first.outcome).toBe("done");
    github.putCode(t.repositoryId, HEAD_2, { "src/renamed.ts": A_TS }, { branch: "main" });
    await push(t, HEAD_2);
    const second = await runCodeIndex(deps(), await claim(t));
    expect(second).toMatchObject({
      outcome: "done",
      chunksReused: 0,
      chunksEmbedded: first.chunksEmbedded,
      filesRemoved: 1,
    });
    // The stored vector is the one made for the new path.
    const prepared = await prepareFile(chunker, "src/renamed.ts", new TextEncoder().encode(A_TS));
    if (prepared.kind !== "chunks") throw new Error("expected chunks");
    const chunk = prepared.chunks[0]!;
    const query = await embedder.embed({ inputs: [embeddingInput("src/renamed.ts", chunk)] });
    const repoId = await repoIdOf(t);
    const [hit] = await workerDb.withOrg(t.orgId, (tx) =>
      searchCodeChunks(tx, { repoId, space, vector: query.vectors[0]!, k: 1 }),
    );
    expect(hit).toMatchObject({ path: "src/renamed.ts", startLine: chunk.startLine });
    expect(hit!.score).toBeCloseTo(1, 5);
  });

  it("identical chunks in two files each get the vector of their own path", async () => {
    const t = await tenant();
    github.putCode(
      t.repositoryId,
      HEAD_1,
      { "src/x.py": B_PY, "src/y.py": B_PY },
      { branch: "main" },
    );
    await push(t, HEAD_1);
    const run = await runCodeIndex(deps(), await claim(t));
    expect(run).toMatchObject({ outcome: "done", chunksReused: 0 });
    expect(run.chunksEmbedded).toBe(run.chunksWritten);
    const repoId = await repoIdOf(t);
    for (const path of ["src/x.py", "src/y.py"]) {
      const prepared = await prepareFile(chunker, path, new TextEncoder().encode(B_PY));
      if (prepared.kind !== "chunks") throw new Error("expected chunks");
      const query = await embedder.embed({
        inputs: [embeddingInput(path, prepared.chunks[0]!)],
      });
      const [hit] = await workerDb.withOrg(t.orgId, (tx) =>
        searchCodeChunks(tx, { repoId, space, vector: query.vectors[0]!, k: 1 }),
      );
      expect(hit?.path).toBe(path);
      expect(hit!.score).toBeCloseTo(1, 5);
    }
  });
});
