import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type {
  ArchiveFile,
  BlobRead,
  CodeReader,
  CodeSession,
  ForgeTree,
  LlmRoles,
  OrgId,
} from "@rocky-reviews/core";
import { createDb, enqueueCodeIndex, type Db } from "@rocky-reviews/db";
// The benchmark is a test harness, not production code: it runs on a throwaway Postgres
// container with seeded fixtures, like the e2e tests, and nothing imports it.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- see above
import { asWorker, seedOrg, startPostgres } from "@rocky-reviews/db/testing";
import {
  createTreeSitterChunker,
  deterministicEmbedder,
  gitBlobSha,
  prepareFile,
} from "@rocky-reviews/indexer";
import { llmConfigFromEnv, usageTargetsFor } from "@rocky-reviews/llm";
import { createLogger } from "@rocky-reviews/log";
import pg from "pg";
import { DEFAULT_INTERVALS } from "./jobs.js";
import { runCodeIndex, type CodeIndexRunReport } from "./code-index.js";

/**
 * `pnpm index:bench` (P9-1): how long a full index of a ~100k-line repository and the re-index
 * of a push take, with everything real except the two network ends. A synthetic repository
 * (TypeScript, Python and Go files of plain functions and classes, generated from a seed) is
 * served from memory as a forge would serve it; the deterministic embedder stands in for the
 * provider, with a configurable latency per call and batch size; Postgres is a throwaway
 * container (Docker), migrated, with the real roles, RLS and HNSW index. Nothing reaches GitHub
 * or a model provider, and no key is read.
 *
 *   pnpm index:bench [--loc 100000] [--lines-per-file 150] [--embed-latency-ms 0]
 *                    [--embed-batch 128] [--dimensions 1024] [--forge-latency-ms 0]
 *                    [--push-files 20] [--without-hnsw]
 *
 * `--without-hnsw` drops the approximate index first: the difference is what maintaining it
 * costs the writes (ADR 0040 §3).
 *
 * Exits non-zero when the full index takes over 600 s or the push re-index, plus the worst wait
 * in the inbox and index queues (2 s + 10 s), over 30 s.
 *
 * The live timing (a real repository, a real provider) is a maintainer's step: see
 * docs/runbooks/index-live-timing.md.
 */

const { values } = parseArgs({
  options: {
    loc: { type: "string", default: "100000" },
    "lines-per-file": { type: "string", default: "150" },
    "embed-latency-ms": { type: "string", default: "0" },
    "embed-batch": { type: "string", default: "128" },
    dimensions: { type: "string", default: "1024" },
    "forge-latency-ms": { type: "string", default: "0" },
    "push-files": { type: "string", default: "20" },
    "without-hnsw": { type: "boolean", default: false },
  },
});
const int = (
  name: Exclude<keyof typeof values, "without-hnsw">,
  min: number,
  max: number,
): number => {
  const value = Number(values[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  }
  return value;
};
const LOC = int("loc", 100, 5_000_000);
const LINES_PER_FILE = int("lines-per-file", 10, 5_000);
const EMBED_LATENCY_MS = int("embed-latency-ms", 0, 60_000);
const EMBED_BATCH = int("embed-batch", 1, 2048);
const DIMENSIONS = int("dimensions", 1, 1024);
const FORGE_LATENCY_MS = int("forge-latency-ms", 0, 60_000);
const PUSH_FILES = int("push-files", 1, 10_000);
/** The P9-1 criteria; the push figure includes the worst wait in the two queues. */
const FULL_INDEX_MAX_SECONDS = 600;
const PUSH_REINDEX_MAX_SECONDS = 30;

// --- A synthetic repository ------------------------------------------------------------------

let seed = 0x9e3779b9;
const random = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 0xffffffff;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const WORDS = [
  "invoice",
  "order",
  "user",
  "total",
  "price",
  "cache",
  "token",
  "row",
  "item",
  "key",
];
const ident = () =>
  `${pick(WORDS)}${pick(WORDS).replace(/^./, (c) => c.toUpperCase())}${Math.floor(random() * 1000)}`;

const body = (indent: string, lines: number): string[] =>
  Array.from(
    { length: lines },
    () => `${indent}const ${ident()} = ${ident()} + ${Math.floor(random() * 100)};`,
  );

const typescriptFile = (lines: number): string => {
  const out: string[] = [`import { ${ident()} } from "./${pick(WORDS)}";`, ""];
  while (out.length < lines) {
    if (random() < 0.3) {
      out.push(`export class ${ident()} {`);
      for (let m = 0; m < 3; m++) {
        out.push(
          `  ${ident()}(input: number): number {`,
          ...body("    ", 6),
          "    return input;",
          "  }",
          "",
        );
      }
      out.push("}", "");
    } else {
      out.push(
        `export function ${ident()}(input: number): number {`,
        ...body("  ", 10),
        "  return input;",
        "}",
        "",
      );
    }
  }
  return out.slice(0, lines).join("\n") + "\n";
};

const pythonFile = (lines: number): string => {
  const out: string[] = ["import os", ""];
  while (out.length < lines) {
    out.push(
      `def ${ident()}(value):`,
      ...Array.from({ length: 10 }, () => `    ${ident()} = value + ${Math.floor(random() * 100)}`),
      "    return value",
      "",
      "",
    );
  }
  return out.slice(0, lines).join("\n") + "\n";
};

const goFile = (lines: number): string => {
  const out: string[] = ["package main", ""];
  while (out.length < lines) {
    out.push(
      `func ${ident()}(value int) int {`,
      ...Array.from({ length: 10 }, () => `\t${ident()} := value + ${Math.floor(random() * 100)}`),
      "\treturn value",
      "}",
      "",
    );
  }
  return out.slice(0, lines).join("\n") + "\n";
};

const generate = (): Map<string, Uint8Array> => {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const count = Math.ceil(LOC / LINES_PER_FILE);
  for (let i = 0; i < count; i++) {
    const kind = i % 3;
    const dir = `src/${pick(WORDS)}/${pick(WORDS)}`;
    const path =
      kind === 0 ? `${dir}/m${i}.ts` : kind === 1 ? `${dir}/m${i}.py` : `${dir}/m${i}.go`;
    const text =
      kind === 0
        ? typescriptFile(LINES_PER_FILE)
        : kind === 1
          ? pythonFile(LINES_PER_FILE)
          : goFile(LINES_PER_FILE);
    files.set(path, encoder.encode(text));
  }
  return files;
};

// --- The forge, from memory ------------------------------------------------------------------

const delay = (ms: number): Promise<void> =>
  ms === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

const memoryForge = (
  commits: Map<string, Map<string, Uint8Array>>,
  head: () => string,
): CodeReader => ({
  openCode: () => {
    const byBlob = new Map<string, Uint8Array>();
    for (const files of commits.values())
      for (const bytes of files.values()) byBlob.set(gitBlobSha(bytes), bytes);
    const session: CodeSession = {
      repository: { id: 1, fullName: "bench/repo", private: true, defaultBranch: "main" },
      branchHead: async () => (await delay(FORGE_LATENCY_MS), head()),
      repositorySizeKb: () => Promise.resolve(null),
      readTree: async (sha): Promise<ForgeTree | null> => {
        await delay(FORGE_LATENCY_MS);
        const files = commits.get(sha);
        if (files === undefined) return null;
        return {
          commitSha: sha,
          truncated: false,
          entries: [...files].map(([path, bytes]) => ({
            path,
            blobSha: gitBlobSha(bytes),
            size: bytes.byteLength,
          })),
        };
      },
      readBlob: async (sha, { maxBytes }): Promise<BlobRead> => {
        await delay(FORGE_LATENCY_MS);
        const bytes = byBlob.get(sha);
        if (bytes === undefined) return { kind: "not_found" };
        return bytes.byteLength > maxBytes ? { kind: "too_large" } : { kind: "ok", bytes };
      },
      readArchive: async function* (sha, { maxFileBytes, wanted }): AsyncIterable<ArchiveFile> {
        await delay(FORGE_LATENCY_MS);
        for (const [path, bytes] of commits.get(sha) ?? []) {
          if (!wanted(path)) continue;
          yield {
            path,
            size: bytes.byteLength,
            bytes: bytes.byteLength > maxFileBytes ? null : bytes,
          };
        }
      },
      close: () => Promise.resolve(),
    };
    return Promise.resolve(session);
  },
});

// --- The run ---------------------------------------------------------------------------------

const seconds = (ms: number): number => Math.round(ms) / 1000;
const out = (label: string, data: Record<string, unknown>): void => {
  process.stdout.write(`${label} ${JSON.stringify(data)}\n`);
};

const main = async (): Promise<void> => {
  const files1 = generate();
  const lines = [...files1.values()].reduce(
    (n, b) => n + new TextDecoder().decode(b).split("\n").length - 1,
    0,
  );
  const bytes = [...files1.values()].reduce((n, b) => n + b.byteLength, 0);
  out("repository", { files: files1.size, lines, bytes });

  const chunker = await createTreeSitterChunker();
  const started = performance.now();
  let chunkCount = 0;
  for (const [path, content] of files1) {
    const prepared = await prepareFile(chunker, path, content);
    if (prepared.kind === "chunks") chunkCount += prepared.chunks.length;
  }
  const chunkMs = performance.now() - started;
  out("chunking", {
    seconds: seconds(chunkMs),
    chunks: chunkCount,
    linesPerSecond: Math.round(lines / (chunkMs / 1000)),
  });

  const pgs = await startPostgres();
  if (values["without-hnsw"] === true) {
    const admin = new pg.Client({ connectionString: pgs.superUrl });
    await admin.connect();
    await admin.query("drop index embeddings_hnsw_idx");
    await admin.end();
  }
  const db: Db = createDb({ connectionString: pgs.workerUrl, max: 4 });
  try {
    const org = await asWorker(pgs.workerUrl, (w) =>
      seedOrg(w, randomUUID() as OrgId, { installationId: 1 }),
    );
    const embedder = deterministicEmbedder({
      dimensions: DIMENSIONS,
      latencyMs: EMBED_LATENCY_MS,
      maxBatch: EMBED_BATCH,
    });
    // Where the time goes: tenant transactions (writes, lookups, usage rows) and embedding calls.
    const spent = { dbMs: 0, embedMs: 0 };
    const timed: Db = {
      ...db,
      withOrg: async (orgId, fn) => {
        const t0 = performance.now();
        try {
          return await db.withOrg(orgId, fn);
        } finally {
          spent.dbMs += performance.now() - t0;
        }
      },
    };
    const embedding = {
      embed: async (request: Parameters<typeof embedder.embed>[0]) => {
        const t0 = performance.now();
        try {
          return await embedder.embed(request);
        } finally {
          spent.embedMs += performance.now() - t0;
        }
      },
    };
    const llm: LlmRoles = {
      completion: () => {
        throw new Error("no completions");
      },
      embedding: () => embedding,
    };
    const usageTargets = {
      ...usageTargetsFor(llmConfigFromEnv({})),
      embed: { provider: "fake", model: embedder.model },
    };
    const space = { provider: "fake", model: embedder.model, dimensions: DIMENSIONS };
    const commits = new Map([["1".repeat(40), files1]]);
    let head = "1".repeat(40);
    const deps = {
      db: timed,
      forge: memoryForge(commits, () => head),
      llm,
      usageTargets,
      space,
      chunker,
      log: createLogger("index-bench", { level: "warn" }),
      tokenLimit: 500_000_000,
      embedBatch: EMBED_BATCH,
    };
    const run = async (): Promise<{ report: CodeIndexRunReport; ms: number }> => {
      await db.withOrg(org.orgId, (tx) => enqueueCodeIndex(tx, org.repoId, null));
      const [claim] = await db.claimCodeIndexes({ limit: 1, leaseSeconds: 3600 });
      if (claim === undefined) throw new Error("bench: nothing claimed");
      spent.dbMs = 0;
      spent.embedMs = 0;
      const t0 = performance.now();
      const report = await runCodeIndex(deps, claim);
      return { report, ms: performance.now() - t0 };
    };

    const full = await run();
    out("full_index", {
      seconds: seconds(full.ms),
      linesPerSecond: Math.round(lines / (full.ms / 1000)),
      embedCalls: embedder.calls,
      dbSeconds: seconds(spent.dbMs),
      embedSeconds: seconds(spent.embedMs),
      embedLatencyMs: EMBED_LATENCY_MS,
      embedBatch: EMBED_BATCH,
      forgeLatencyMs: FORGE_LATENCY_MS,
      ...full.report,
    });

    // A push: PUSH_FILES files change one function each, a few are deleted, a few added.
    const files2 = new Map(files1);
    const paths = [...files1.keys()];
    const encoder = new TextEncoder();
    for (let i = 0; i < PUSH_FILES; i++) {
      const path = paths[(i * 7919) % paths.length] as string;
      const text = new TextDecoder().decode(files1.get(path));
      files2.set(
        path,
        encoder.encode(text.replace(/\+ (\d+)/, (_, n: string) => `+ ${Number(n) + 1}`)),
      );
    }
    for (let i = 0; i < 3; i++) files2.delete(paths[paths.length - 1 - i] as string);
    for (let i = 0; i < 3; i++)
      files2.set(`src/new/n${i}.ts`, encoder.encode(typescriptFile(LINES_PER_FILE)));
    commits.set("2".repeat(40), files2);
    head = "2".repeat(40);
    const calls = embedder.calls;
    const incremental = await run();
    out("push_reindex", {
      seconds: seconds(incremental.ms),
      changedFiles: PUSH_FILES + 3,
      deletedFiles: 3,
      embedCalls: embedder.calls - calls,
      dbSeconds: seconds(spent.dbMs),
      embedSeconds: seconds(spent.embedMs),
      ...incremental.report,
    });

    // The criteria (P9-1): a full index under 10 minutes, a push re-index under 30 s. A push
    // also waits in two queues before its run starts: the inbox poll and the index lane's tick
    // (DEFAULT_INTERVALS, jobs.ts), counted here at their worst.
    const queueSeconds = (DEFAULT_INTERVALS.inboxMs + DEFAULT_INTERVALS.indexMs) / 1000;
    const pushSeconds = seconds(incremental.ms) + queueSeconds;
    const fullOk = full.report.outcome === "done" && full.ms / 1000 <= FULL_INDEX_MAX_SECONDS;
    const pushOk = incremental.report.outcome === "done" && pushSeconds <= PUSH_REINDEX_MAX_SECONDS;
    out("criteria", {
      fullIndexSeconds: seconds(full.ms),
      fullIndexMaxSeconds: FULL_INDEX_MAX_SECONDS,
      fullIndexPass: fullOk,
      pushReindexSeconds: seconds(incremental.ms),
      worstQueueSeconds: queueSeconds,
      pushWithQueueSeconds: Math.round(pushSeconds * 1000) / 1000,
      pushReindexMaxSeconds: PUSH_REINDEX_MAX_SECONDS,
      pushReindexPass: pushOk,
    });
    passed = fullOk && pushOk;
  } finally {
    await db.close();
    await pgs.stop();
  }
};

let passed = false;
await main();
// Non-zero when a criterion is missed, so the benchmark can gate a change.
process.exitCode = passed ? 0 : 1;
