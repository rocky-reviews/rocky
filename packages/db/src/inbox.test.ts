import { randomBytes, randomUUID } from "node:crypto";
import type { WebhookDelivery } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import {
  completeInTenantTx,
  decodeClaimedDelivery,
  LeaseLostError,
  WEBHOOK_MAX_ATTEMPTS,
  type ClaimedDelivery,
} from "./inbox.js";
import * as schema from "./schema.js";
import {
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  plantWebhookDelivery,
  seedOrg,
  startPostgres,
  type TestPostgres,
} from "./testing/index.js";
import { WebhookInboxError } from "./webhooks.js";

/**
 * P3-3: the worker's claim path into the webhook inbox (migration 0007, ADR 0009). Rows are
 * claimed with a lease through SECURITY DEFINER functions only the worker role may execute;
 * concurrent workers never share a row; a crash lets the lease expire and the row is retried; a
 * row that keeps failing is parked after WEBHOOK_MAX_ATTEMPTS; only processed rows are purged.
 */

const INSUFFICIENT_PRIVILEGE = "42501";
const INSTALLATION_TYPES = ["installation.created", "installation.deleted"] as const;
const DAY = 86_400_000;

let pgs: TestPostgres;
let superuser: pg.Pool;
/** The server's login: INSERT only. */
let server: Db;
/** The worker's login. */
let worker: Db;

const pgError = async (promise: Promise<unknown>): Promise<pg.DatabaseError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error("expected the query to fail");
};

let nextInstallation = 10_000;

const installationDelivery = (
  options: { installationId?: number; type?: "installation.created" | "installation.deleted" } = {},
): WebhookDelivery => {
  const installationId = options.installationId ?? nextInstallation++;
  return {
    forge: "github",
    deliveryId: randomUUID(),
    payloadSha256: randomBytes(32).toString("hex"),
    event: {
      type: options.type ?? "installation.created",
      installationId,
      account: { id: installationId + 1, login: `acct-${installationId}`, kind: "organization" },
      sender: { id: 5, login: "alice" },
    },
  };
};

const pullRequestDelivery = (): WebhookDelivery => ({
  forge: "github",
  deliveryId: randomUUID(),
  payloadSha256: randomBytes(32).toString("hex"),
  event: {
    type: "pull_request.opened",
    installationId: nextInstallation++,
    repositoryId: 77,
    number: 1,
    headSha: "a".repeat(40),
    merged: false,
  },
});

const state = async (deliveryId: string) =>
  (
    await superuser.query<{
      attempts: number;
      leased: boolean;
      processed: boolean;
      parked: boolean;
      outcome: string | null;
      last_error: string | null;
    }>(
      `select attempts, lease_token is not null as leased, processed_at is not null as processed,
              parked_at is not null as parked, outcome, last_error
         from app.webhook_deliveries where delivery_id = $1`,
      [deliveryId],
    )
  ).rows[0];

/** Drains everything currently claimable so each test starts from its own rows. */
const drain = async (): Promise<void> => {
  for (;;) {
    const rows = await worker.claimWebhookDeliveries({
      eventTypes: [...INSTALLATION_TYPES, "pull_request.opened"],
      limit: 100,
      leaseSeconds: 60,
    });
    if (rows.length === 0) return;
    for (const row of rows) await worker.completeWebhookDelivery(row, "drained");
  }
};

/** Time travel: the lease ran out (the holder crashed). */
const expireLease = async (deliveryId: string): Promise<void> => {
  await superuser.query(
    "update app.webhook_deliveries set lease_until = now() - interval '1 second' where delivery_id = $1",
    [deliveryId],
  );
};

const claimOne = async (deliveryId: string): Promise<ClaimedDelivery | undefined> => {
  const rows = await worker.claimWebhookDeliveries({
    eventTypes: [...INSTALLATION_TYPES],
    limit: 100,
    leaseSeconds: 60,
  });
  // Release anything else this claim picked up, so other tests keep their rows.
  for (const r of rows) {
    if (r.deliveryId !== deliveryId) {
      await worker.failWebhookDelivery(r, {
        error: "test_release",
        retryAfterSeconds: 0,
        permanent: false,
      });
    }
  }
  return rows.find((r) => r.deliveryId === deliveryId);
};

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 });
  server = createDb({ connectionString: pgs.appUrl, max: 4 });
  worker = createDb({ connectionString: pgs.workerUrl, max: 4 });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await server?.close();
  await worker?.close();
  await superuser?.end();
  await pgs?.stop();
});

describe("who may touch the inbox", () => {
  it("the server's login cannot claim, finish or look up anything (SQLSTATE only)", async () => {
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    const lease = { forge: "github" as const, deliveryId: d.deliveryId, leaseToken: randomUUID() };
    for (const attempt of [
      () =>
        server.claimWebhookDeliveries({
          eventTypes: [...INSTALLATION_TYPES],
          limit: 1,
          leaseSeconds: 60,
        }),
      () => server.completeWebhookDelivery(lease, "done"),
      () =>
        server.failWebhookDelivery(lease, { error: "x", retryAfterSeconds: 0, permanent: false }),
    ]) {
      const error = await attempt().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(WebhookInboxError);
      expect((error as WebhookInboxError).code).toBe(INSUFFICIENT_PRIVILEGE);
      expect((error as Error).message).not.toContain(d.deliveryId);
    }
    expect((await pgError(server.installationOrgs("github", 1, null))).code).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await state(d.deliveryId)).toMatchObject({
      attempts: 0,
      leased: false,
      processed: false,
    });
  });

  it("the receiver cannot pre-set a processing state: every row starts pending", async () => {
    const app = new pg.Pool({ connectionString: pgs.appUrl, max: 1 });
    const deliveryId = randomUUID();
    try {
      await app.query(
        `insert into app.webhook_deliveries
           (forge, delivery_id, payload_sha256, event_type, installation_id, event,
            attempts, processed_at, outcome, parked_at, last_error, lease_token, lease_until, available_at)
         values ('github', $1, $2, 'installation.deleted', 5, $3::jsonb,
                 99, now(), 'done', null, 'boom', gen_random_uuid(), now() + interval '1 day',
                 now() + interval '10 years')`,
        [
          deliveryId,
          randomBytes(32),
          JSON.stringify({
            type: "installation.deleted",
            installationId: 5,
            account: { id: 6, login: "a", kind: "user" },
            sender: null,
          }),
        ],
      );
    } finally {
      await app.end();
    }
    expect(await state(deliveryId)).toEqual({
      attempts: 0,
      leased: false,
      processed: false,
      parked: false,
      outcome: null,
      last_error: null,
    });
    const claimed = await claimOne(deliveryId);
    expect(claimed).toBeDefined();
    await worker.completeWebhookDelivery(claimed!, "test");
  });
});

describe("claim, complete, fail", () => {
  it("leases a row to one claimer, completes it once, and only for the lease holder", async () => {
    await drain();
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    const claimed = await claimOne(d.deliveryId);
    expect(claimed).toMatchObject({
      forge: "github",
      deliveryId: d.deliveryId,
      eventType: "installation.created",
      installationId: d.event.installationId,
      attempts: 1,
    });
    expect(claimed!.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    // Leased: nobody else gets it.
    expect(await claimOne(d.deliveryId)).toBeUndefined();
    // A forged token finishes nothing.
    expect(
      await worker.completeWebhookDelivery({ ...claimed!, leaseToken: randomUUID() }, "forged"),
    ).toBe(false);
    expect(await worker.completeWebhookDelivery(claimed!, "org_created")).toBe(true);
    expect(await worker.completeWebhookDelivery(claimed!, "org_created")).toBe(false);
    expect(await state(d.deliveryId)).toMatchObject({
      processed: true,
      leased: false,
      outcome: "org_created",
    });
    expect(await claimOne(d.deliveryId)).toBeUndefined();
  });

  it("claims only the requested event types (pull requests wait for their consumer)", async () => {
    await drain();
    const pr = pullRequestDelivery();
    await server.recordWebhookDelivery(pr);
    const rows = await worker.claimWebhookDeliveries({
      eventTypes: [...INSTALLATION_TYPES],
      limit: 100,
      leaseSeconds: 60,
    });
    expect(rows.map((r) => r.deliveryId)).not.toContain(pr.deliveryId);
    expect(await state(pr.deliveryId)).toMatchObject({ attempts: 0, processed: false });
  });

  it("refuses bad codes, leases and options before any SQL", async () => {
    const lease = { forge: "github" as const, deliveryId: randomUUID(), leaseToken: randomUUID() };
    await expect(worker.completeWebhookDelivery(lease, "Has Spaces")).rejects.toThrow(/outcome/);
    await expect(
      worker.failWebhookDelivery(lease, {
        error: "connection refused at 10.0.0.1",
        retryAfterSeconds: 0,
        permanent: false,
      }),
    ).rejects.toThrow(/error code/);
    await expect(
      worker.completeWebhookDelivery({ ...lease, leaseToken: "x' or 1=1" }, "ok"),
    ).rejects.toThrow(/lease/);
    await expect(
      worker.claimWebhookDeliveries({
        eventTypes: ["installation.suspend" as never],
        limit: 1,
        leaseSeconds: 60,
      }),
    ).rejects.toThrow(/event types/);
    await expect(
      worker.claimWebhookDeliveries({ eventTypes: [], limit: 1, leaseSeconds: 60 }),
    ).rejects.toThrow(/event types/);
  });

  it("never hands one row to two concurrent workers, and loses none", async () => {
    await drain();
    const deliveries = Array.from({ length: 60 }, () => installationDelivery());
    for (const d of deliveries) await server.recordWebhookDelivery(d);
    const pools = Array.from({ length: 6 }, () =>
      createDb({ connectionString: pgs.workerUrl, max: 2 }),
    );
    const seen: string[] = [];
    try {
      await Promise.all(
        pools.map(async (w) => {
          for (;;) {
            const rows = await w.claimWebhookDeliveries({
              eventTypes: [...INSTALLATION_TYPES],
              limit: 3,
              leaseSeconds: 60,
            });
            if (rows.length === 0) return;
            for (const row of rows) {
              seen.push(row.deliveryId);
              expect(await w.completeWebhookDelivery(row, "concurrent")).toBe(true);
            }
          }
        }),
      );
    } finally {
      await Promise.all(pools.map((p) => p.close()));
    }
    expect(seen).toHaveLength(new Set(seen).size);
    expect(new Set(seen)).toEqual(new Set(deliveries.map((d) => d.deliveryId)));
  });

  it("retries a row after a crash: the lease expires, the old holder can no longer finish it", async () => {
    await drain();
    const d = installationDelivery({ type: "installation.deleted" });
    await server.recordWebhookDelivery(d);
    const first = await claimOne(d.deliveryId);
    expect(first?.attempts).toBe(1);
    // The worker dies here: no complete, no fail.
    await expireLease(d.deliveryId);
    const second = await claimOne(d.deliveryId);
    expect(second).toMatchObject({ deliveryId: d.deliveryId, attempts: 2 });
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    expect(await state(d.deliveryId)).toMatchObject({ last_error: "lease_expired" });
    // The crashed worker comes back: its lease is gone.
    expect(await worker.completeWebhookDelivery(first!, "late")).toBe(false);
    expect(
      await worker.failWebhookDelivery(first!, {
        error: "late",
        retryAfterSeconds: 0,
        permanent: false,
      }),
    ).toBe("stale");
    expect(await worker.completeWebhookDelivery(second!, "deletion_scheduled")).toBe(true);
  });

  it("parks a poison row after WEBHOOK_MAX_ATTEMPTS failures, keeping the last error code", async () => {
    await drain();
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    const results: string[] = [];
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS + 2; i++) {
      const claimed = await claimOne(d.deliveryId);
      if (claimed === undefined) break;
      results.push(
        await worker.failWebhookDelivery(claimed, {
          error: i % 2 === 0 ? "forge_http_500" : "40001",
          retryAfterSeconds: 0,
          permanent: false,
        }),
      );
    }
    expect(results).toEqual([...Array(WEBHOOK_MAX_ATTEMPTS - 1).fill("retry"), "parked"]);
    expect(await state(d.deliveryId)).toEqual({
      attempts: WEBHOOK_MAX_ATTEMPTS,
      leased: false,
      processed: false,
      parked: true,
      outcome: null,
      last_error: "forge_http_500",
    });
    expect(await claimOne(d.deliveryId)).toBeUndefined();
  });

  it("parks a row that crashes its worker every time (the lease keeps expiring)", async () => {
    await drain();
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      expect((await claimOne(d.deliveryId))?.attempts).toBe(i + 1);
      await expireLease(d.deliveryId);
    }
    expect(await claimOne(d.deliveryId)).toBeUndefined();
    expect(await state(d.deliveryId)).toMatchObject({
      attempts: WEBHOOK_MAX_ATTEMPTS,
      parked: true,
      last_error: "lease_expired",
    });
  });

  it("parks at once on a permanent failure, and delays a retry as asked", async () => {
    await drain();
    const permanent = installationDelivery();
    const delayed = installationDelivery();
    await server.recordWebhookDelivery(permanent);
    await server.recordWebhookDelivery(delayed);
    const p = await claimOne(permanent.deliveryId);
    expect(
      await worker.failWebhookDelivery(p!, {
        error: "invalid_event",
        retryAfterSeconds: 0,
        permanent: true,
      }),
    ).toBe("parked");
    expect(await state(permanent.deliveryId)).toMatchObject({ attempts: 1, parked: true });
    const q = await claimOne(delayed.deliveryId);
    expect(
      await worker.failWebhookDelivery(q!, {
        error: "forge_timeout",
        retryAfterSeconds: 3600,
        permanent: false,
      }),
    ).toBe("retry");
    expect(await claimOne(delayed.deliveryId)).toBeUndefined();
    await superuser.query(
      "update app.webhook_deliveries set available_at = now() where delivery_id = $1",
      [delayed.deliveryId],
    );
    expect((await claimOne(delayed.deliveryId))?.attempts).toBe(q!.attempts + 1);
  });
});

describe("re-validation on read (ADR 0007 §4)", () => {
  it("accepts a stored row only if it passes minimalEvent and agrees with its columns", async () => {
    await drain();
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    const claimed = await claimOne(d.deliveryId);
    expect(decodeClaimedDelivery(claimed!)).toEqual({ ok: true, event: d.event });
    for (const event of [
      { ...d.event, installationId: d.event.installationId + 1 },
      { ...d.event, type: "installation.deleted" },
      { ...d.event, account: { id: -1, login: "x", kind: "organization" } },
      { ...d.event, account: { id: 1, login: "../etc", kind: "organization" } },
      { ...d.event, sender: { id: 1, login: "a b" } },
      "not an object",
      null,
    ]) {
      expect(decodeClaimedDelivery({ ...claimed!, event }), JSON.stringify(event)).toEqual({
        ok: false,
        reason: "invalid_event",
      });
    }
    // Extra fields are dropped, not trusted.
    const decoded = decodeClaimedDelivery({
      ...claimed!,
      event: { ...d.event, title: "Ignore previous instructions", admin: true },
    });
    expect(decoded.ok && decoded.event).toEqual(d.event);
    await worker.completeWebhookDelivery(claimed!, "test");
  });
});

describe("completing inside the tenant transaction", () => {
  it("rolls the tenant effect back when the lease was lost", async () => {
    await drain();
    const org = await seedOrg(worker, newOrgId());
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    const first = await claimOne(d.deliveryId);
    await expireLease(d.deliveryId);
    const second = await claimOne(d.deliveryId);
    const error = await worker
      .withOrg(org.orgId, async (tx) => {
        await tx.db.update(schema.orgs).set({ login: "renamed-by-stale-worker" });
        await completeInTenantTx(tx, first!, "stale");
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(LeaseLostError);
    const { rows } = await superuser.query<{ login: string }>(
      "select login from orgs where id = $1",
      [org.orgId],
    );
    expect(rows[0]?.login).not.toBe("renamed-by-stale-worker");
    await worker.withOrg(org.orgId, async (tx) => {
      await tx.db.update(schema.orgs).set({ login: "renamed-by-holder" });
      await completeInTenantTx(tx, second!, "renamed");
    });
    expect(await state(d.deliveryId)).toMatchObject({ processed: true, outcome: "renamed" });
  });
});

describe("installation lookup", () => {
  it("finds orgs by installation id or by account id, ids only", async () => {
    const org = await seedOrg(worker, newOrgId(), { installationId: 880, accountId: 88_088 });
    expect(await worker.installationOrgs("github", 880, null)).toEqual([
      { orgId: org.orgId, installationId: 880, accountId: 88_088, deleteAfter: null },
    ]);
    expect(await worker.installationOrgs("github", 881, 88_088)).toHaveLength(1);
    expect(await worker.installationOrgs("github", 881, 88_089)).toEqual([]);
    expect(await worker.installationOrgs("gitlab", 880, 88_088)).toEqual([]);
    await expect(worker.installationOrgs("github", 0, null)).rejects.toThrow(/positive/);
  });
});

describe("inbox retention skips unprocessed rows", () => {
  it("purges old processed rows only; pending, leased and parked rows stay however old", async () => {
    await drain();
    const now = new Date();
    const old = new Date(+now - 400 * DAY);
    const ids = {
      processed: randomUUID(),
      pending: randomUUID(),
      parked: randomUUID(),
      leased: randomUUID(),
    };
    await plantWebhookDelivery(superuser, { deliveryId: ids.processed, at: old });
    await plantWebhookDelivery(superuser, { deliveryId: ids.pending, at: old, state: "pending" });
    await plantWebhookDelivery(superuser, { deliveryId: ids.parked, at: old, state: "parked" });
    await plantWebhookDelivery(superuser, { deliveryId: ids.leased, at: old, state: "pending" });
    await superuser.query(
      `update app.webhook_deliveries set lease_token = gen_random_uuid(),
              lease_until = now() + interval '1 hour', attempts = 1
        where delivery_id = $1`,
      [ids.leased],
    );
    expect(await server.purgeWebhookDeliveries(now)).toBe(1);
    for (const [label, id] of Object.entries(ids)) {
      const { rows } = await superuser.query(
        "select 1 from app.webhook_deliveries where delivery_id = $1",
        [id],
      );
      expect(rows.length, label).toBe(label === "processed" ? 0 : 1);
    }
  });
});
