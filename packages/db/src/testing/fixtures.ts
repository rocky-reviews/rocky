import { randomUUID } from "node:crypto";
import type { OrgId } from "@rocky-reviews/core";
import type { Db } from "../client.js";
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
 * Inserts one row in every tenant table for `orgId`, inside `withOrg`. Used by the isolation
 * suite (which also asserts that every table in the database received exactly one row, so a
 * new table without a fixture here fails that suite) and by the audit/retention tests.
 */
export const seedOrg = async (
  db: Db,
  orgId: OrgId,
  options: { installationId?: number; createdAt?: Date } = {},
): Promise<SeededOrg> => {
  const installationId = options.installationId ?? nextInstallationId++;
  const createdAt = options.createdAt ?? new Date();
  return db.withOrg(orgId, async ({ db: tx }) => {
    await tx.insert(schema.orgs).values({
      id: orgId,
      installationId,
      login: `org-${installationId}`,
      kind: "organization",
    });
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
    const audit = first(
      await tx
        .insert(schema.auditEvents)
        .values({
          actorType: "user",
          actorId: member.id,
          action: "fixture.seeded",
          targetType: "org",
          targetId: orgId,
          createdAt,
        })
        .returning({ id: schema.auditEvents.id }),
    );
    const usage = first(
      await tx
        .insert(schema.llmUsage)
        .values({
          analysisId: analysis.id,
          role: "review",
          provider: "anthropic",
          model: "test-model",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicroUsd: 42,
          priceVersion: "2026-10",
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
