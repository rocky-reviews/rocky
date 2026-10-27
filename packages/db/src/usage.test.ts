import { randomUUID } from "node:crypto";
import type { LlmUsageRecord, OrgId } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { beginOrgErasure } from "./installations.js";
import { DEFAULT_RETENTION, LLM_USAGE_MIN_RETENTION_DAYS, runRetention } from "./retention.js";
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
import { LLM_USAGE_MAX_RECORDS, recordLlmUsage, UsageStoreError } from "./usage.js";

/**
 * P4-5 (migration 0011, ADR 0015): the llm_usage ledger. Written by the worker inside withOrg,
 * append-only for every role (the owner included), readable by the server for its own tenant
 * only, purged by retention after its period and erased with its org.
 */

const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";

let pgs: TestPostgres;
let superuser: pg.Pool;
let worker: Db;
let server: Db;
let A: SeededOrg;
let B: SeededOrg;

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  worker = createDb({ connectionString: pgs.workerUrl, max: 2 });
  server = createDb({ connectionString: pgs.appUrl, max: 2 });
  A = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 41 }));
  B = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 42 }));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await worker?.close();
  await server?.close();
  await superuser?.end();
  await pgs?.stop();
});

const pgError = async (promise: Promise<unknown>): Promise<pg.DatabaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error("expected the query to fail");
};

const thrown = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
};

const record = (overrides: Partial<LlmUsageRecord> = {}): LlmUsageRecord => ({
  callId: randomUUID(),
  attempt: 0,
  role: "review",
  provider: "anthropic",
  model: "claude-opus-5-5",
  outcome: "ok",
  usageStatus: "reported",
  tokens: {
    inputTokens: 1200,
    outputTokens: 800,
    cacheReadTokens: 3000,
    cacheWrite5mTokens: 2048,
    cacheWrite1hTokens: 512,
  },
  costMicroUsd: 35_736,
  costStatus: "priced",
  priceVersion: "2026-10-27",
  ...overrides,
});

const rowsOf = async (orgId: OrgId, where = "true", values: unknown[] = []) =>
  (
    await superuser.query<Record<string, unknown>>(
      `select * from llm_usage where org_id = $1 and ${where} order by id`,
      [orgId, ...values],
    )
  ).rows;

describe("recordLlmUsage", () => {
  it("stores every field of a record inside withOrg, for the current tenant", async () => {
    const analysisId = A.analysisId;
    const failed = record({
      outcome: "error",
      errorKind: "rate_limited",
      usageStatus: "unreported",
      tokens: null,
      costMicroUsd: null,
      costStatus: "no_usage",
      analysisId,
    });
    const fallback = record({ attempt: 1, callId: failed.callId, analysisId, outcome: "ok" });
    await worker.withOrg(A.orgId, (tx) => recordLlmUsage(tx, [failed, fallback]));
    const rows = await rowsOf(A.orgId, "call_id = $2", [failed.callId]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      org_id: A.orgId,
      analysis_id: analysisId,
      call_id: failed.callId,
      attempt: 0,
      role: "review",
      provider: "anthropic",
      model: "claude-opus-5-5",
      outcome: "error",
      error_kind: "rate_limited",
      usage_status: "unreported",
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_5m_tokens: null,
      cache_write_1h_tokens: null,
      cost_micro_usd: null,
      cost_status: "no_usage",
      price_version: "2026-10-27",
    });
    expect(rows[1]).toMatchObject({
      attempt: 1,
      outcome: "ok",
      error_kind: null,
      input_tokens: 1200,
      output_tokens: 800,
      cache_read_tokens: 3000,
      cache_write_5m_tokens: 2048,
      cache_write_1h_tokens: 512,
      cost_micro_usd: "35736",
    });
  });

  it("stores a retried write once: (call, attempt) is unique per org", async () => {
    const once = record();
    await worker.withOrg(A.orgId, (tx) => recordLlmUsage(tx, [once]));
    await worker.withOrg(A.orgId, (tx) => recordLlmUsage(tx, [once]));
    expect(await rowsOf(A.orgId, "call_id = $2", [once.callId])).toHaveLength(1);
    // The same ids in another tenant are another row (ids are per org).
    await worker.withOrg(B.orgId, (tx) => recordLlmUsage(tx, [once]));
    expect(await rowsOf(B.orgId, "call_id = $2", [once.callId])).toHaveLength(1);
  });

  it("refuses a malformed record before any SQL, with a fixed message", async () => {
    const bad: [string, Partial<LlmUsageRecord>][] = [
      ["call id", { callId: "not-a-uuid" }],
      ["attempt", { attempt: 16 }],
      ["attempt", { attempt: 0.5 }],
      ["role", { role: "admin" as never }],
      ["provider", { provider: "Anthropic API" }],
      ["model", { model: "claude'; drop table llm_usage; --" }],
      ["analysis id", { analysisId: "x" }],
      ["outcome", { outcome: "approved" as never }],
      ["error kind", { errorKind: "rate_limited" }],
      ["error kind", { outcome: "error", errorKind: "teapot" as never }],
      ["usage", { usageStatus: "partial" }],
      ["tokens", { tokens: { ...record().tokens!, inputTokens: -1 } }],
      ["tokens", { tokens: { ...record().tokens!, outputTokens: 2 ** 31 } }],
      ["tokens", { tokens: null }],
      ["cost", { costMicroUsd: null }],
      ["cost", { costMicroUsd: 1.5 }],
      ["cost", { costStatus: "no_price" }],
      ["price version", { priceVersion: "latest" }],
    ];
    for (const [label, overrides] of bad) {
      const error = await thrown(
        worker.withOrg(A.orgId, (tx) => recordLlmUsage(tx, [record(overrides)])),
      );
      expect(error, label).toBeInstanceOf(UsageStoreError);
      expect((error as Error).message, label).toMatch(/^llm usage: invalid /);
    }
    const tooMany = Array.from({ length: LLM_USAGE_MAX_RECORDS + 1 }, () => record());
    expect(
      await thrown(worker.withOrg(A.orgId, (tx) => recordLlmUsage(tx, tooMany))),
    ).toBeInstanceOf(UsageStoreError);
  });

  it("keeps only the SQLSTATE of a database error (the server login cannot insert)", async () => {
    const error = await thrown(server.withOrg(A.orgId, (tx) => recordLlmUsage(tx, [record()])));
    expect(error).toBeInstanceOf(UsageStoreError);
    expect((error as UsageStoreError).code).toBe(INSUFFICIENT_PRIVILEGE);
    expect((error as Error).message).toBe("llm usage: the database refused the write");
    expect((error as Error).cause).toBeUndefined();
  });
});

describe("the llm_usage table", () => {
  it("lets the server read its own tenant's rows and nobody else's", async () => {
    const own = await server.withOrg(A.orgId, (tx) =>
      tx.query<{ org_id: string }>("select org_id from llm_usage"),
    );
    expect(own.rows.length).toBeGreaterThan(0);
    expect(new Set(own.rows.map((r) => r.org_id))).toEqual(new Set([A.orgId]));
    const foreign = await server.withOrg(A.orgId, (tx) =>
      tx.query("select 1 from llm_usage where org_id = $1", [B.orgId]),
    );
    expect(foreign.rowCount).toBe(0);
  });

  it("refuses a worker insert for another tenant (RLS WITH CHECK)", async () => {
    const error = await pgError(
      worker.withOrg(A.orgId, (tx) =>
        tx.query(
          `insert into llm_usage (org_id, call_id, attempt, role, provider, model, outcome,
             usage_status, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens,
             cache_write_1h_tokens, cost_micro_usd, cost_status, price_version)
           values ($1, gen_random_uuid(), 0, 'review', 'anthropic', 'm', 'ok', 'reported',
             1, 1, 0, 0, 0, 1, 'priced', '2026-10-27')`,
          [B.orgId],
        ),
      ),
    );
    expect(error.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("is append-only for the server, the worker and the owner", async () => {
    for (const db of [server, worker]) {
      for (const sql of [
        "update llm_usage set input_tokens = 0",
        "update llm_usage set cost_micro_usd = 0 where cost_micro_usd is not null",
        "delete from llm_usage",
      ]) {
        const error = await pgError(db.withOrg(A.orgId, (tx) => tx.query(sql)));
        expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
      }
    }
    // The owner (migrator) is stopped by the trigger, not by grants. FORCE RLS hides every row
    // from it, so lift FORCE inside a rolled-back transaction to prove the trigger is the fence.
    const owner = await pgs.migrator.connect();
    try {
      await owner.query("begin");
      await owner.query("alter table llm_usage no force row level security");
      expect((await owner.query("select 1 from llm_usage")).rowCount).toBeGreaterThan(0);
      for (const sql of [
        "update llm_usage set output_tokens = 0",
        // Unlinking is allowed only on its own: together with any other change it is refused.
        "update llm_usage set analysis_id = null, cost_micro_usd = 0 where analysis_id is not null and cost_micro_usd is not null",
        "update llm_usage set created_at = now() - interval '5 years'",
        "delete from llm_usage",
        "truncate llm_usage",
      ]) {
        await owner.query("savepoint s");
        const error = await pgError(owner.query(sql));
        expect(error.code, sql).toBe(INSUFFICIENT_PRIVILEGE);
        expect(error.message, sql).toMatch(/append-only/);
        await owner.query("rollback to savepoint s");
      }
      await owner.query("rollback");
    } finally {
      owner.release();
    }
  });

  it("stamps created_at with the database clock, whatever the writer sends", async () => {
    const callId = randomUUID();
    await worker.withOrg(A.orgId, (tx) =>
      tx.query(
        `insert into llm_usage (call_id, attempt, role, provider, model, outcome, usage_status,
           input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens,
           cache_write_1h_tokens, cost_micro_usd, cost_status, price_version, created_at)
         values ($1, 0, 'graph', 'anthropic', 'claude-sonnet-5-5', 'ok', 'reported', 1, 1, 0, 0, 0,
           1, 'priced', '2026-10-27', now() - interval '5 years')`,
        [callId],
      ),
    );
    const [row] = await rowsOf(A.orgId, "call_id = $2", [callId]);
    expect(Date.now() - (row!["created_at"] as Date).getTime()).toBeLessThan(60_000);
  });

  it("enforces the record's invariants in the database too (a writer that skips the checks)", async () => {
    const insert = (columns: Record<string, unknown>) => {
      const base: Record<string, unknown> = {
        call_id: randomUUID(),
        attempt: 0,
        role: "review",
        provider: "anthropic",
        model: "claude-opus-5-5",
        outcome: "ok",
        usage_status: "reported",
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cost_micro_usd: 1,
        cost_status: "priced",
        price_version: "2026-10-27",
        ...columns,
      };
      const names = Object.keys(base);
      return worker.withOrg(A.orgId, (tx) =>
        tx.query(
          `insert into llm_usage (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
          Object.values(base),
        ),
      );
    };
    const violations: Record<string, unknown>[] = [
      { cost_micro_usd: null },
      { cost_status: "no_price" },
      { input_tokens: null },
      { usage_status: "unreported" },
      {
        usage_status: "unreported",
        input_tokens: null,
        output_tokens: null,
        cache_read_tokens: null,
        cache_write_5m_tokens: null,
        cache_write_1h_tokens: null,
        cost_micro_usd: null,
        cost_status: "priced",
      },
      { usage_status: "partial" },
      { error_kind: "rate_limited" },
      { outcome: "approved" },
      { role: "owner" },
      { model: "a model with spaces" },
      { model: "x".repeat(201) },
      { provider: "ANTHROPIC" },
      { price_version: "v1" },
      { attempt: 16 },
      { cache_write_1h_tokens: -1 },
      { cost_micro_usd: -1 },
    ];
    for (const columns of violations) {
      const error = await pgError(insert(columns));
      expect(error.code, JSON.stringify(columns)).toBe(CHECK_VIOLATION);
    }
    // A row with no usage and no cost is valid when it says so.
    await insert({
      outcome: "error",
      error_kind: "auth",
      usage_status: "unreported",
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_5m_tokens: null,
      cache_write_1h_tokens: null,
      cost_micro_usd: null,
      cost_status: "no_usage",
    });
  });
});

describe("retention and erasure", () => {
  it("keeps usage when its analysis is purged, unlinking it (the one allowed update)", async () => {
    const org = await asWorker(pgs.workerUrl, (w) =>
      seedOrg(w, newOrgId(), { installationId: 43 }),
    );
    const linked = record({ analysisId: org.analysisId });
    await worker.withOrg(org.orgId, (tx) => recordLlmUsage(tx, [linked]));
    await superuser.query("alter table analyses disable trigger user");
    await superuser.query(
      "update analyses set created_at = now() - interval '400 days' where org_id = $1",
      [org.orgId],
    );
    await superuser.query("alter table analyses enable trigger user");
    await server.purgeExpired("analyses", new Date());
    const [row] = await rowsOf(org.orgId, "call_id = $2", [linked.callId]);
    expect(row).toMatchObject({ analysis_id: null, input_tokens: 1200, cost_micro_usd: "35736" });
  });

  it("purges rows past the llm_usage period (default 730 days, floor 400), audited per org", async () => {
    expect(DEFAULT_RETENTION.llmUsageDays).toBe(730);
    expect(LLM_USAGE_MIN_RETENTION_DAYS).toBe(400);
    const org = await asWorker(pgs.workerUrl, (w) =>
      seedOrg(w, newOrgId(), { installationId: 44 }),
    );
    const old = record();
    const fresh = record();
    await worker.withOrg(org.orgId, (tx) => recordLlmUsage(tx, [old, fresh]));
    await superuser.query("alter table llm_usage disable trigger user");
    await superuser.query(
      "update llm_usage set created_at = now() - interval '731 days' where call_id = $1",
      [old.callId],
    );
    await superuser.query("alter table llm_usage enable trigger user");
    const report = await runRetention(server, { clock: { now: () => new Date() } });
    const usage = report.categories.find((c) => c.category === "llm_usage");
    expect(usage).toMatchObject({ table: "llm_usage" });
    expect(usage!.deleted).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(org.orgId, "call_id = $2", [old.callId])).toHaveLength(0);
    expect(await rowsOf(org.orgId, "call_id = $2", [fresh.callId])).toHaveLength(1);
    const audited = await superuser.query(
      `select metadata from audit_events
        where org_id = $1 and action = 'retention.purged' and target_id = 'llm_usage'`,
      [org.orgId],
    );
    expect(audited.rows[0]?.metadata).toMatchObject({ category: "llm_usage", deleted: 1 });
    // The floor is the database's: the owner cannot set a shorter period.
    const floor = await pgError(
      pgs.migrator.query(
        "update app.retention_settings set days = 399 where category = 'llm_usage'",
      ),
    );
    expect(floor.code).toBe(CHECK_VIOLATION);
  });

  it("cannot be pushed forward: a future as_of is clamped to the database clock", async () => {
    const org = await asWorker(pgs.workerUrl, (w) =>
      seedOrg(w, newOrgId(), { installationId: 46 }),
    );
    const kept = record();
    await worker.withOrg(org.orgId, (tx) => recordLlmUsage(tx, [kept]));
    await superuser.query("alter table llm_usage disable trigger user");
    await superuser.query(
      "update llm_usage set created_at = now() - interval '729 days' where call_id = $1",
      [kept.callId],
    );
    await superuser.query("alter table llm_usage enable trigger user");
    await server.purgeExpired("llm_usage", new Date(Date.now() + 365 * 86_400_000));
    expect(await rowsOf(org.orgId, "call_id = $2", [kept.callId])).toHaveLength(1);
  });

  it("erases an org's usage with the org and counts it in the tombstone", async () => {
    const org = await asWorker(pgs.workerUrl, (w) =>
      seedOrg(w, newOrgId(), { installationId: 45 }),
    );
    await worker.withOrg(org.orgId, (tx) => recordLlmUsage(tx, [record(), record()]));
    // Time travel past the grace period (as deletion.test.ts does), then the sweep's mark.
    await superuser.query("alter table orgs disable trigger user");
    try {
      await superuser.query(
        "update orgs set delete_after = now() - interval '1 second' where id = $1",
        [org.orgId],
      );
    } finally {
      await superuser.query("alter table orgs enable trigger user");
    }
    expect(await worker.withOrg(org.orgId, (tx) => beginOrgErasure(tx))).not.toBe("not_due");
    const report = await worker.deleteOrg(org.orgId);
    expect(report).toContainEqual({ table: "llm_usage", deleted: 3 });
    expect(await rowsOf(org.orgId)).toHaveLength(0);
    const tombstone = await superuser.query<{ llm_usage_deleted: string }>(
      "select llm_usage_deleted::text from app.org_deletions where org_id = $1",
      [org.orgId],
    );
    expect(tombstone.rows[0]?.llm_usage_deleted).toBe("3");
    // Other tenants keep theirs.
    expect((await rowsOf(B.orgId)).length).toBeGreaterThan(0);
  });
});
