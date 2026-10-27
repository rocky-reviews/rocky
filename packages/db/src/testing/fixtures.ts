import { randomUUID } from "node:crypto";
import type { OrgId } from "@rocky-reviews/core";
import type pg from "pg";
import { createDb, type Db } from "../client.js";
import * as schema from "../schema.js";

export interface SeededOrg {
  orgId: OrgId;
  memberId: string;
  repoId: string;
  pullRequestId: string;
  revisionId: string;
  analysisId: string;
  findingStateId: string;
  commentId: string;
  memoryEntryId: string;
  embeddingId: string;
  jobId: string;
  auditEventId: number;
  llmUsageId: number;
}

export const EMBEDDING_DIMENSIONS = 1536;

/** A minimal, valid analysis document stand-in; the real shape is validated in packages/schema. */
const DOCUMENT = { version: "test", findings: [] };

let nextInstallationId = 1;

const first = <T>(rows: T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error("fixture insert returned no row");
  return row;
};

/**
 * Inserts one row in every tenant table for `orgId`, inside `withOrg`. `db` must connect as the
 * worker login (`TestPostgres.workerUrl`): only the worker creates orgs (migration 0007). Used
 * by the isolation
 * suite (which also asserts that every table in the database received exactly one row, so a
 * new table without a fixture here fails that suite) and by the audit/retention tests.
 */
export const seedOrg = async (
  db: Db,
  orgId: OrgId,
  options: {
    installationId?: number;
    accountId?: number;
    createdAt?: Date;
    /** The org row already exists (created by the installation lifecycle): fill the rest. */
    orgExists?: boolean;
  } = {},
): Promise<SeededOrg> => {
  const installationId = options.installationId ?? nextInstallationId++;
  const accountId = options.accountId ?? 1_000_000 + installationId;
  const createdAt = options.createdAt ?? new Date();
  return db.withOrg(orgId, async ({ db: tx }) => {
    if (options.orgExists !== true) {
      await tx.insert(schema.orgs).values({
        id: orgId,
        installationId,
        accountId,
        login: `org-${installationId}`,
        kind: "organization",
      });
    }
    const member = first(
      await tx
        .insert(schema.members)
        .values({ forgeUserId: 1001, login: "alice", role: "admin" })
        .returning({ id: schema.members.id }),
    );
    const repo = first(
      await tx
        .insert(schema.repos)
        .values({ forgeRepoId: 2001, fullName: `org-${installationId}/api` })
        .returning({ id: schema.repos.id }),
    );
    const pr = first(
      await tx
        .insert(schema.pullRequests)
        .values({
          repoId: repo.id,
          number: 847,
          title: "Invite flow",
          authorLogin: "alice",
          state: "open",
          headSha: "a".repeat(40),
          baseSha: "b".repeat(40),
          openedAt: createdAt,
        })
        .returning({ id: schema.pullRequests.id }),
    );
    const revision = first(
      await tx
        .insert(schema.prRevisions)
        .values({ pullRequestId: pr.id, headSha: "a".repeat(40), baseSha: "b".repeat(40) })
        .returning({ id: schema.prRevisions.id }),
    );
    const analysis = first(
      await tx
        .insert(schema.analyses)
        .values({
          revisionId: revision.id,
          status: "done",
          document: DOCUMENT,
          createdAt,
          completedAt: createdAt,
        })
        .returning({ id: schema.analyses.id }),
    );
    const finding = first(
      await tx
        .insert(schema.findingsState)
        .values({ analysisId: analysis.id, findingId: "f-1", state: "draft" })
        .returning({ id: schema.findingsState.id }),
    );
    const comment = first(
      await tx
        .insert(schema.commentsPending)
        .values({
          pullRequestId: pr.id,
          revisionId: revision.id,
          authorId: member.id,
          path: "src/invite.ts",
          line: 12,
          body: "Consider validating the email first.",
        })
        .returning({ id: schema.commentsPending.id }),
    );
    const memory = first(
      await tx
        .insert(schema.memoryEntries)
        .values({
          repoId: repo.id,
          kind: "convention",
          content: "Use the shared validator for emails.",
          createdBy: member.id,
        })
        .returning({ id: schema.memoryEntries.id }),
    );
    const embedding = first(
      await tx
        .insert(schema.embeddings)
        .values({
          repoId: repo.id,
          memoryEntryId: memory.id,
          sourceKind: "memory",
          sourceRef: memory.id,
          model: "test-embed",
          embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0),
        })
        .returning({ id: schema.embeddings.id }),
    );
    const job = first(
      await tx
        .insert(schema.jobs)
        .values({
          kind: "analyse",
          idempotencyKey: `analyse:${revision.id}`,
          status: "done",
          createdAt,
          finishedAt: createdAt,
        })
        .returning({ id: schema.jobs.id }),
    );
    // No createdAt: the stamp trigger (0004) sets it to now() for the application role.
    const audit = first(
      await tx
        .insert(schema.auditEvents)
        .values({
          actorType: "user",
          actorId: member.id,
          action: "fixture.seeded",
          targetType: "org",
          targetId: orgId,
        })
        .returning({ id: schema.auditEvents.id }),
    );
    const usage = first(
      await tx
        .insert(schema.llmUsage)
        .values({
          analysisId: analysis.id,
          callId: randomUUID(),
          attempt: 0,
          role: "review",
          provider: "anthropic",
          model: "test-model",
          outcome: "ok",
          usageStatus: "reported",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          costMicroUsd: 42,
          costStatus: "priced",
          priceVersion: "2026-10-27",
        })
        .returning({ id: schema.llmUsage.id }),
    );

    return {
      orgId,
      memberId: member.id,
      repoId: repo.id,
      pullRequestId: pr.id,
      revisionId: revision.id,
      analysisId: analysis.id,
      findingStateId: finding.id,
      commentId: comment.id,
      memoryEntryId: memory.id,
      embeddingId: embedding.id,
      jobId: job.id,
      auditEventId: audit.id,
      llmUsageId: usage.id,
    };
  });
};

export const newOrgId = (): OrgId => randomUUID() as OrgId;

/**
 * Runs `fn` with a short-lived Db on the worker login (the only one allowed to create orgs,
 * migration 0007), e.g. `await asWorker(pgs.workerUrl, (w) => seedOrg(w, id))`.
 */
export const asWorker = async <T>(
  workerUrl: string,
  fn: (worker: Db) => Promise<T>,
): Promise<T> => {
  const worker = createDb({ connectionString: workerUrl, max: 2 });
  try {
    return await fn(worker);
  } finally {
    await worker.close();
  }
};

/**
 * Inserts an audit event with an explicit `created_at`, which the stamp trigger (0004) refuses
 * for every role. Tests of retention boundaries need old rows, so this runs as the superuser
 * with the trigger disabled for the duration of one transaction. Never used by product code.
 */
export const plantAuditEvent = async (
  superuser: pg.Pool,
  orgId: OrgId,
  options: { action: string; at: Date },
): Promise<void> => {
  const client = await superuser.connect();
  try {
    await client.query("begin");
    await client.query("alter table public.audit_events disable trigger audit_events_stamp");
    await client.query(
      `insert into public.audit_events (org_id, actor_type, actor_id, action, target_type, target_id, created_at)
       values ($1::uuid, 'system', 'test', $2, 'org', $1::text, $3)`,
      [orgId, options.action, options.at],
    );
    await client.query("alter table public.audit_events enable trigger audit_events_stamp");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Inserts a webhook inbox row with an explicit `received_at`, which the stamp trigger (0006)
 * overrides for every role. Superuser, trigger disabled for one transaction; tests only.
 */
export const plantWebhookDelivery = async (
  superuser: pg.Pool,
  options: {
    deliveryId: string;
    at: Date;
    /** Default: processed at `at` (only processed rows are purged, migration 0007). */
    state?: "processed" | "pending" | "parked";
  },
): Promise<void> => {
  const state = options.state ?? "processed";
  const client = await superuser.connect();
  const event = {
    type: "pull_request.opened",
    installationId: 1,
    repositoryId: 1,
    number: 1,
    headSha: "a".repeat(40),
    merged: false,
  };
  try {
    await client.query("begin");
    await client.query(
      "alter table app.webhook_deliveries disable trigger webhook_deliveries_stamp",
    );
    await client.query(
      `insert into app.webhook_deliveries
         (forge, delivery_id, payload_sha256, event_type, installation_id, event, received_at,
          processed_at, outcome, parked_at, attempts)
       values ('github', $1, sha256(convert_to($1, 'utf8')), $2, 1, $3::jsonb, $4,
               case when $5 = 'processed' then $4::timestamptz end,
               case when $5 = 'processed' then 'planted' end,
               case when $5 = 'parked' then $4::timestamptz end,
               case when $5 = 'pending' then 0 else 1 end)`,
      [options.deliveryId, event.type, JSON.stringify(event), options.at, state],
    );
    await client.query(
      "alter table app.webhook_deliveries enable trigger webhook_deliveries_stamp",
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Marks one queued analysis `running` under a fresh lease, as the claim would, without going
 * through the cross-org claim (whose fair order would hand out other tests' rows). For tests of
 * what a lease holder may do; the claim itself is tested in analysis-queue.test.ts. Superuser;
 * tests only.
 */
export const plantAnalysisLease = async (
  superuser: pg.Pool,
  analysisId: string,
  options: { leaseSeconds?: number } = {},
): Promise<{ analysisId: string; leaseId: string }> => {
  const { rows } = await superuser.query<{ lease_id: string }>(
    `update public.analyses
        set status = 'running', attempts = attempts + 1, claimed_at = now(),
            lease_id = gen_random_uuid(),
            lease_until = now() + make_interval(secs => $2)
      where id = $1 and status = 'queued'
      returning lease_id::text as lease_id`,
    [analysisId, options.leaseSeconds ?? 600],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("plantAnalysisLease: the row is not queued");
  return { analysisId, leaseId: row.lease_id };
};
