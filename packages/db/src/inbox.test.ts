import { randomBytes, randomUUID } from "node:crypto";
import {
  FORGE_EVENT_TYPES,
  INSTALLATION_EVENT_TYPES,
  PULL_REQUEST_EVENT_TYPES,
  type WebhookDelivery,
} from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import {
  completeInTenantTx,
  decodeClaimedDelivery,
  CLAIM_STATEMENT_TIMEOUT_MS,
  laneEventTypes,
  laneOf,
  LeaseLostError,
  WEBHOOK_MAX_STRIKES,
  WEBHOOK_TRANSIENT_PARK_HOURS,
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
  ignoreIdleError,
} from "./testing/index.js";
import { WebhookInboxError } from "./webhooks.js";

/**
 * P3-3: the worker's claim path into the webhook inbox (migration 0007, ADR 0009). Rows are
 * claimed with a lease through SECURITY DEFINER functions only the worker role may execute;
 * concurrent workers never share a row; a crash lets the lease expire and the row is retried; a
 * row that keeps striking is parked after WEBHOOK_MAX_STRIKES, one that only fails transiently
 * after WEBHOOK_TRANSIENT_PARK_HOURS; only processed rows are purged. Review round 1: claims are
 * per forge (M3), at most one live lease per installation (S2). Review round 2 (A): nothing is
 * superseded at claim time, and installation rows must have minimalEvent's shape to be stored.
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
      strikes: number;
      leased: boolean;
      processed: boolean;
      parked: boolean;
      outcome: string | null;
      last_error: string | null;
    }>(
      `select attempts, strikes, lease_token is not null as leased, processed_at is not null as processed,
              parked_at is not null as parked, outcome, last_error
         from app.webhook_deliveries where delivery_id = $1`,
      [deliveryId],
    )
  ).rows[0];

/** Drains everything currently claimable so each test starts from its own rows. */
const drain = async (): Promise<void> => {
  for (;;) {
    const rows = await worker.claimWebhookDeliveries({
      forge: "github",
      eventTypes: [...INSTALLATION_TYPES, ...PULL_REQUEST_EVENT_TYPES],
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
    forge: "github",
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
        kind: "transient",
      });
    }
  }
  return rows.find((r) => r.deliveryId === deliveryId);
};

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
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
          forge: "github",
          eventTypes: [...INSTALLATION_TYPES],
          limit: 1,
          leaseSeconds: 60,
        }),
      () => server.completeWebhookDelivery(lease, "done"),
      () =>
        server.failWebhookDelivery(lease, { error: "x", retryAfterSeconds: 0, kind: "transient" }),
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
    const app = new pg.Pool({ connectionString: pgs.appUrl, max: 1 }).on("error", ignoreIdleError);
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
      strikes: 0,
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
    expect(claimed!.strikes).toBe(0);
    const leaseMs = +claimed!.leaseUntil - Date.now();
    expect(leaseMs).toBeGreaterThan(50_000);
    expect(leaseMs).toBeLessThanOrEqual(61_000);
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
      forge: "github",
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
        kind: "transient",
      }),
    ).rejects.toThrow(/error code/);
    await expect(
      worker.completeWebhookDelivery({ ...lease, leaseToken: "x' or 1=1" }, "ok"),
    ).rejects.toThrow(/lease/);
    await expect(
      worker.claimWebhookDeliveries({
        forge: "github",
        eventTypes: ["installation.suspend" as never],
        limit: 1,
        leaseSeconds: 60,
      }),
    ).rejects.toThrow(/event types/);
    await expect(
      worker.claimWebhookDeliveries({
        forge: "github",
        eventTypes: [],
        limit: 1,
        leaseSeconds: 60,
      }),
    ).rejects.toThrow(/event types/);
  });

  it("P3-4: claims whole lanes only, so no lane head is ever skipped for its type", async () => {
    expect(laneOf("installation.created")).toBe("installation");
    expect(laneOf("pull_request.synchronize")).toBe("pull_request");
    expect(laneEventTypes("installation")).toEqual(INSTALLATION_EVENT_TYPES);
    expect(laneEventTypes("pull_request")).toEqual(PULL_REQUEST_EVENT_TYPES);
    for (const partial of [
      ["installation.created"],
      ["pull_request.opened", "pull_request.closed"],
      [...INSTALLATION_EVENT_TYPES, "pull_request.opened"],
    ] as const) {
      await expect(
        worker.claimWebhookDeliveries({
          forge: "github",
          eventTypes: partial,
          limit: 1,
          leaseSeconds: 60,
        }),
        partial.join(","),
      ).rejects.toThrow(/whole lanes/);
    }
    // The inbox stores exactly the types the domain knows, so whole lanes of FORGE_EVENT_TYPES
    // cover every head the claim can meet.
    const { rows } = await superuser.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'app.webhook_deliveries'::regclass and contype = 'c'
          and pg_get_constraintdef(oid) like '%pull_request.opened%'`,
    );
    expect(rows).toHaveLength(1);
    const stored = [...rows[0]!.def.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(stored).toEqual([...FORGE_EVENT_TYPES].sort());
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
              forge: "github",
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
    expect(second).toMatchObject({ deliveryId: d.deliveryId, attempts: 2, strikes: 1 });
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    expect(await state(d.deliveryId)).toMatchObject({ last_error: "lease_expired" });
    // The crashed worker comes back: its lease is gone.
    expect(await worker.completeWebhookDelivery(first!, "late")).toBe(false);
    expect(
      await worker.failWebhookDelivery(first!, {
        error: "late",
        retryAfterSeconds: 0,
        kind: "transient",
      }),
    ).toBe("stale");
    expect(await worker.completeWebhookDelivery(second!, "deletion_scheduled")).toBe(true);
  });

  it("parks a poison row after WEBHOOK_MAX_STRIKES strikes, keeping the last error code", async () => {
    await drain();
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    const results: string[] = [];
    for (let i = 0; i < WEBHOOK_MAX_STRIKES + 2; i++) {
      const claimed = await claimOne(d.deliveryId);
      if (claimed === undefined) break;
      expect(claimed.strikes).toBe(i);
      results.push(
        await worker.failWebhookDelivery(claimed, {
          error: i % 2 === 0 ? "forge_contradiction" : "invalid_response",
          retryAfterSeconds: 0,
          kind: "strike",
        }),
      );
    }
    expect(results).toEqual([...Array(WEBHOOK_MAX_STRIKES - 1).fill("retry"), "parked"]);
    expect(await state(d.deliveryId)).toEqual({
      attempts: WEBHOOK_MAX_STRIKES,
      strikes: WEBHOOK_MAX_STRIKES,
      leased: false,
      processed: false,
      parked: true,
      outcome: null,
      last_error: "forge_contradiction",
    });
    expect(await claimOne(d.deliveryId)).toBeUndefined();
  });

  it("never parks a row for transient failures (an outage) until it is 72 h old (S3)", async () => {
    await drain();
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    for (let i = 0; i < WEBHOOK_MAX_STRIKES * 3; i++) {
      const claimed = await claimOne(d.deliveryId);
      expect(claimed?.attempts).toBe(i + 1);
      expect(
        await worker.failWebhookDelivery(claimed!, {
          error: ["forge_timeout", "forge_http_503", "forge_http_429", "forge_http_401"][i % 4]!,
          retryAfterSeconds: 0,
          kind: "transient",
        }),
      ).toBe("retry");
    }
    expect(await state(d.deliveryId)).toMatchObject({ strikes: 0, parked: false });
    // Still failing after WEBHOOK_TRANSIENT_PARK_HOURS: parked for a human.
    await superuser.query(
      `update app.webhook_deliveries set received_at = now() - make_interval(hours => $2 + 1)
        where delivery_id = $1`,
      [d.deliveryId, WEBHOOK_TRANSIENT_PARK_HOURS],
    );
    const last = await claimOne(d.deliveryId);
    expect(
      await worker.failWebhookDelivery(last!, {
        error: "forge_timeout",
        retryAfterSeconds: 0,
        kind: "transient",
      }),
    ).toBe("parked");
    expect(await state(d.deliveryId)).toMatchObject({ strikes: 0, parked: true });
  });

  it("parks on an unknown failure kind (fail closed in the database too)", async () => {
    await drain();
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    const claimed = await claimOne(d.deliveryId);
    await expect(
      worker.failWebhookDelivery(claimed!, {
        error: "x",
        retryAfterSeconds: 0,
        kind: "maybe" as never,
      }),
    ).rejects.toThrow(/invalid failure/);
    const raw = new pg.Pool({ connectionString: pgs.workerUrl, max: 1 }).on(
      "error",
      ignoreIdleError,
    );
    try {
      const { rows } = await raw.query<{ r: string }>(
        "select worker.fail_webhook_delivery('github', $1, $2::uuid, 'x', 0, 'maybe') as r",
        [d.deliveryId, claimed!.leaseToken],
      );
      expect(rows[0]?.r).toBe("parked");
    } finally {
      await raw.end();
    }
  });

  it("parks a row that crashes its worker every time (the lease keeps expiring)", async () => {
    await drain();
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    for (let i = 0; i < WEBHOOK_MAX_STRIKES; i++) {
      expect((await claimOne(d.deliveryId))?.attempts).toBe(i + 1);
      await expireLease(d.deliveryId);
    }
    expect(await claimOne(d.deliveryId)).toBeUndefined();
    expect(await state(d.deliveryId)).toMatchObject({
      attempts: WEBHOOK_MAX_STRIKES,
      strikes: WEBHOOK_MAX_STRIKES,
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
        kind: "permanent",
      }),
    ).toBe("parked");
    expect(await state(permanent.deliveryId)).toMatchObject({ attempts: 1, parked: true });
    const q = await claimOne(delayed.deliveryId);
    expect(
      await worker.failWebhookDelivery(q!, {
        error: "forge_timeout",
        retryAfterSeconds: 3600,
        kind: "transient",
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

describe("claim ordering (review round 1: M3, S2, L5)", () => {
  it("claims only rows of the worker's forge; another forge's rows wait untouched (M3)", async () => {
    await drain();
    const gitlab = { ...installationDelivery(), forge: "gitlab" as const };
    await server.recordWebhookDelivery(gitlab);
    const rows = await worker.claimWebhookDeliveries({
      forge: "github",
      eventTypes: [...INSTALLATION_TYPES],
      limit: 100,
      leaseSeconds: 60,
    });
    expect(rows.map((r) => r.deliveryId)).not.toContain(gitlab.deliveryId);
    expect(await state(gitlab.deliveryId)).toMatchObject({ attempts: 0, leased: false });
    const theirs = await worker.claimWebhookDeliveries({
      forge: "gitlab",
      eventTypes: [...INSTALLATION_TYPES],
      limit: 100,
      leaseSeconds: 60,
    });
    expect(theirs.map((r) => [r.forge, r.deliveryId])).toEqual([["gitlab", gitlab.deliveryId]]);
    await worker.completeWebhookDelivery(theirs[0]!, "test");
    await expect(
      worker.claimWebhookDeliveries({
        forge: "bitbucket" as never,
        eventTypes: [...INSTALLATION_TYPES],
        limit: 1,
        leaseSeconds: 60,
      }),
    ).rejects.toThrow(/forge/);
  });

  it("hands out one row per installation at a time, oldest first, even to concurrent workers (S2)", async () => {
    await drain();
    const installationId = nextInstallation++;
    const created = installationDelivery({ installationId, type: "installation.created" });
    const deleted = installationDelivery({ installationId, type: "installation.deleted" });
    await server.recordWebhookDelivery(created);
    await server.recordWebhookDelivery(deleted);
    await superuser.query(
      `update app.webhook_deliveries set received_at = received_at - interval '1 second'
        where delivery_id = $1`,
      [created.deliveryId],
    );
    const pools = Array.from({ length: 4 }, () =>
      createDb({ connectionString: pgs.workerUrl, max: 1 }),
    );
    let claimed: ClaimedDelivery[];
    try {
      claimed = (
        await Promise.all(
          pools.map((w) =>
            w.claimWebhookDeliveries({
              forge: "github",
              eventTypes: [...INSTALLATION_TYPES],
              limit: 10,
              leaseSeconds: 60,
            }),
          ),
        )
      )
        .flat()
        .filter((r) => r.installationId === installationId);
    } finally {
      await Promise.all(pools.map((p) => p.close()));
    }
    expect(claimed.map((r) => r.deliveryId)).toEqual([created.deliveryId]);
    // While it is leased, the next event of that installation waits.
    expect(await claimOne(deleted.deliveryId)).toBeUndefined();
    expect(await worker.completeWebhookDelivery(claimed[0]!, "org_created")).toBe(true);
    const next = await claimOne(deleted.deliveryId);
    expect(next?.eventType).toBe("installation.deleted");
    await worker.completeWebhookDelivery(next!, "test");
  });

  it("a delayed head holds back later events of its installation (no overtaking)", async () => {
    await drain();
    const installationId = nextInstallation++;
    const created = installationDelivery({ installationId, type: "installation.created" });
    const deleted = installationDelivery({ installationId, type: "installation.deleted" });
    await server.recordWebhookDelivery(created);
    await server.recordWebhookDelivery(deleted);
    await superuser.query(
      `update app.webhook_deliveries set received_at = received_at - interval '1 second'
        where delivery_id = $1`,
      [created.deliveryId],
    );
    const first = await claimOne(created.deliveryId);
    await worker.failWebhookDelivery(first!, {
      error: "forge_timeout",
      retryAfterSeconds: 3600,
      kind: "transient",
    });
    expect(await claimOne(deleted.deliveryId)).toBeUndefined();
    expect(await state(deleted.deliveryId)).toMatchObject({ attempts: 0 });
  });

  it("never marks a row processed on another row's account at claim or failure; only a completed, verified row collapses earlier duplicates (review rounds 2 A and 3)", async () => {
    await drain();
    const installationId = nextInstallation++;
    const copies = Array.from({ length: 4 }, () =>
      installationDelivery({ installationId, type: "installation.deleted" }),
    );
    for (const c of copies) await server.recordWebhookDelivery(c);
    // Distinct, ordered receive times (same-millisecond inserts would tie on received_at).
    for (const [i, c] of copies.entries()) {
      await superuser.query(
        `update app.webhook_deliveries set received_at = now() - make_interval(secs => $2)
          where delivery_id = $1`,
        [c.deliveryId, 100 - i],
      );
    }
    const pendingOthers = async (except: string) => {
      for (const other of copies) {
        if (other.deliveryId !== except) {
          expect(await state(other.deliveryId), other.deliveryId).toMatchObject({
            processed: false,
            parked: false,
          });
        }
      }
    };
    // Claimed: nothing else changes. Failed (a strike, then parked): nothing else changes.
    const first = await claimOne(copies[0]!.deliveryId);
    await pendingOthers(copies[0]!.deliveryId);
    expect(
      await worker.failWebhookDelivery(first!, {
        error: "invalid_event",
        retryAfterSeconds: 0,
        kind: "permanent",
      }),
    ).toBe("parked");
    await pendingOthers(copies[0]!.deliveryId);
    // The next one is claimed, and a copy arrives after its claim (GitHub's answer read for the
    // claimed row may predate that event).
    const second = await claimOne(copies[1]!.deliveryId);
    const late = installationDelivery({ installationId, type: "installation.deleted" });
    await server.recordWebhookDelivery(late);
    const created = installationDelivery({ installationId, type: "installation.created" });
    await server.recordWebhookDelivery(created);
    await superuser.query(
      "update app.webhook_deliveries set received_at = now() - interval '50 seconds' where delivery_id = $1",
      [created.deliveryId],
    );
    expect(await worker.completeWebhookDelivery(second!, "deletion_scheduled")).toBe(true);
    // Completed after a GitHub-verified decision: the same-type rows received before its claim
    // are answered by that decision; the parked row, the later copy and other types are not.
    for (const c of copies.slice(2)) {
      expect(await state(c.deliveryId)).toMatchObject({
        processed: true,
        outcome: "superseded",
        attempts: 0,
      });
    }
    expect(await state(copies[0]!.deliveryId)).toMatchObject({ parked: true, processed: false });
    expect(await state(late.deliveryId)).toMatchObject({ processed: false });
    expect(await state(created.deliveryId)).toMatchObject({ processed: false });
    for (const id of [created.deliveryId, late.deliveryId]) {
      const next = await claimOne(id);
      expect(next?.deliveryId).toBe(id);
      await worker.completeWebhookDelivery(next!, "test");
    }
  });

  it("a stale lease holder's completion collapses nothing; pull request rows never collapse", async () => {
    await drain();
    const installationId = nextInstallation++;
    const a = installationDelivery({ installationId, type: "installation.deleted" });
    const b = installationDelivery({ installationId, type: "installation.deleted" });
    await server.recordWebhookDelivery(a);
    await server.recordWebhookDelivery(b);
    await superuser.query(
      "update app.webhook_deliveries set received_at = received_at - interval '1 second' where delivery_id = $1",
      [a.deliveryId],
    );
    const held = await claimOne(a.deliveryId);
    expect(await worker.completeWebhookDelivery({ ...held!, leaseToken: randomUUID() }, "x")).toBe(
      false,
    );
    expect(await state(b.deliveryId)).toMatchObject({ processed: false });
    await worker.completeWebhookDelivery(held!, "test");
    // Two pull request events of one installation (different PRs) are both kept.
    const prs = [pullRequestDelivery(), pullRequestDelivery()].map((d) => ({
      ...d,
      event: { ...d.event, installationId },
    }));
    for (const d of prs) await server.recordWebhookDelivery(d as WebhookDelivery);
    const [pr] = await worker.claimWebhookDeliveries({
      forge: "github",
      eventTypes: PULL_REQUEST_EVENT_TYPES,
      limit: 1,
      leaseSeconds: 60,
    });
    expect(pr).toBeDefined();
    expect(await worker.completeWebhookDelivery(pr!, "test")).toBe(true);
    const other = prs.find((d) => d.deliveryId !== pr!.deliveryId)!;
    expect(await state(other.deliveryId)).toMatchObject({ processed: false });
    await drain();
  });

  it("a duplicate waits while another row of its installation is leased (its holder finishes it)", async () => {
    await drain();
    const installationId = nextInstallation++;
    const a = installationDelivery({ installationId, type: "installation.deleted" });
    await server.recordWebhookDelivery(a);
    const held = await claimOne(a.deliveryId);
    const b = installationDelivery({ installationId, type: "installation.deleted" });
    await server.recordWebhookDelivery(b);
    expect(await claimOne(b.deliveryId)).toBeUndefined();
    expect(await state(a.deliveryId)).toMatchObject({ leased: true, processed: false });
    expect(await worker.completeWebhookDelivery(held!, "deletion_scheduled")).toBe(true);
    const next = await claimOne(b.deliveryId);
    expect(next?.deliveryId).toBe(b.deliveryId);
    await worker.completeWebhookDelivery(next!, "test");
  });
});

describe("installation rows must have minimalEvent's shape (review round 2, A)", () => {
  const insertAsApp = async (event: unknown) => {
    const app = new pg.Pool({ connectionString: pgs.appUrl, max: 1 }).on("error", ignoreIdleError);
    try {
      const type = (event as { type: string }).type;
      await app.query(
        `insert into app.webhook_deliveries
           (forge, delivery_id, payload_sha256, event_type, installation_id, event)
         values ('github', $1, $2, $3, 4321, $4::jsonb)`,
        [randomUUID(), randomBytes(32), type, JSON.stringify(event)],
      );
      return undefined;
    } catch (error) {
      if (error instanceof pg.DatabaseError) return error.code;
      throw error;
    } finally {
      await app.end();
    }
  };
  const base = {
    type: "installation.deleted",
    installationId: 4321,
    account: { id: 77, login: "victim", kind: "organization" },
    sender: { id: 9, login: "owner" },
  };

  it("refuses an installation row the worker could not decode, for the receiver's role", async () => {
    const account = base.account;
    for (const [label, event] of [
      ["no account", { type: base.type, installationId: 4321 }],
      ["account array", { ...base, account: [1, 2] }],
      ["account null", { ...base, account: null }],
      ["account id string", { ...base, account: { ...account, id: "77" } }],
      ["account id zero", { ...base, account: { ...account, id: 0 } }],
      ["account id fraction", { ...base, account: { ...account, id: 1.5 } }],
      ["account id too big", { ...base, account: { ...account, id: 2 ** 60 } }],
      ["login missing", { ...base, account: { id: 77, kind: "user" } }],
      ["login bad", { ...base, account: { ...account, login: "../etc" } }],
      ["login number", { ...base, account: { ...account, login: 5 } }],
      ["kind bad", { ...base, account: { ...account, kind: "enterprise" } }],
      ["sender missing", { type: base.type, installationId: 4321, account }],
      ["sender array", { ...base, sender: [] }],
      ["sender id string", { ...base, sender: { id: "9", login: "owner" } }],
      ["sender login bad", { ...base, sender: { id: 9, login: "a b" } }],
      ["created, no account", { type: "installation.created", installationId: 4321, sender: null }],
      ["installation id string", { ...base, installationId: "4321" }],
    ] as const) {
      expect(await insertAsApp(event), label).toBe("23514");
    }
  });

  it("accepts every shape minimalEvent accepts", async () => {
    for (const event of [
      base,
      { ...base, sender: null },
      { ...base, sender: { id: 9, login: "some-app[bot]" } },
      { ...base, type: "installation.created", account: { id: 78, login: "u_1", kind: "user" } },
    ]) {
      expect(await insertAsApp(event), JSON.stringify(event)).toBeUndefined();
    }
    await drain();
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

describe("claim cost and timing (review round 3)", () => {
  it("a 20k-row backlog for one installation does not slow a claim for another", async () => {
    await drain();
    const flooded = nextInstallation++;
    const genuine = installationDelivery({ type: "installation.deleted" });
    const app = new pg.Pool({ connectionString: pgs.appUrl, max: 1 }).on("error", ignoreIdleError);
    try {
      // One INSERT … SELECT as the receiver's role, like a compromised server would.
      await app.query(
        `insert into app.webhook_deliveries
           (forge, delivery_id, payload_sha256, event_type, installation_id, event)
         select 'github',
                (substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12)),
                sha256(convert_to('flood-' || i::text, 'utf8')), 'installation.created', $1::bigint,
                jsonb_build_object('type', 'installation.created', 'installationId', $1::bigint,
                  'account', jsonb_build_object('id', 5, 'login', 'a', 'kind', 'user'), 'sender', null)
           from generate_series(1, 20000) i, lateral (select md5('flood-' || i::text) h) x`,
        [flooded],
      );
    } finally {
      await app.end();
    }
    await server.recordWebhookDelivery(genuine);
    const timings: number[] = [];
    const seen: string[] = [];
    for (let k = 0; k < 3; k++) {
      const started = performance.now();
      const rows = await worker.claimWebhookDeliveries({
        forge: "github",
        eventTypes: [...INSTALLATION_TYPES],
        limit: 10,
        leaseSeconds: 60,
      });
      timings.push(performance.now() - started);
      seen.push(...rows.map((r) => r.deliveryId));
      for (const r of rows) {
        await worker.failWebhookDelivery(r, {
          error: "test_release",
          retryAfterSeconds: 3600,
          kind: "transient",
        });
      }
    }
    expect(seen).toContain(genuine.deliveryId);
    // Bounded per claim whatever the backlog (the old claim took seconds here). Generous for CI.
    expect(Math.max(...timings), timings.map((t) => t.toFixed(0)).join(",")).toBeLessThan(300);
    // Clean up: the flood is finished so later tests see only their own rows. This one UPDATE
    // also bounds the queue trigger on a bulk change: its OLD/NEW join once ran as a nested loop
    // (~49 s for these 20k rows in CI; migration 0009).
    const bulkStarted = performance.now();
    await superuser.query(
      "update app.webhook_deliveries set processed_at = now(), outcome = 'test', lease_token = null, lease_until = null where installation_id = $1 and processed_at is null and parked_at is null",
      [flooded],
    );
    expect(performance.now() - bulkStarted).toBeLessThan(10_000);
    await superuser.query(
      "update app.webhook_deliveries set processed_at = now(), outcome = 'test' where delivery_id = $1 and processed_at is null and parked_at is null",
      [genuine.deliveryId],
    );
  }, 60_000);

  it("a bulk update stays linear on a connection whose trigger plan was made for one row (0009)", async () => {
    // plpgsql plans the queue trigger's join once per connection and reuses it. A 1-row update
    // first (the worker's claim/complete/fail) used to fix a nested loop over the OLD/NEW
    // transition tables that the next bulk update reused: quadratic. One client, so the warm-up
    // and the bulk update share the cached plan whatever the pool hands out.
    const flooded = nextInstallation++;
    const client = new pg.Client({ connectionString: pgs.superUrl });
    client.on("error", ignoreIdleError);
    await client.connect();
    try {
      const { rows: config } = await client.query<{ proconfig: string[] | null }>(
        "select proconfig from pg_catalog.pg_proc where oid = 'worker.webhook_queue_on_update()'::regprocedure",
      );
      expect(config[0]?.proconfig).toContain("enable_nestloop=off");
      await client.query(
        `insert into app.webhook_deliveries
           (forge, delivery_id, payload_sha256, event_type, installation_id, event)
         select 'github',
                (substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||'-8'||substr(h,18,3)||'-'||substr(h,21,12)),
                sha256(convert_to('plan-' || i::text, 'utf8')), 'installation.created', $1::bigint,
                jsonb_build_object('type', 'installation.created', 'installationId', $1::bigint,
                  'account', jsonb_build_object('id', 5, 'login', 'a', 'kind', 'user'), 'sender', null)
           from generate_series(1, 20000) i, lateral (select md5('plan-' || $1::text || '-' || i::text) h) x`,
        [flooded],
      );
      // Warm the cached plan with a one-row statement, as the worker's first call would.
      await client.query(
        `update app.webhook_deliveries set available_at = available_at
          where delivery_id = (select delivery_id from app.webhook_deliveries
                                where installation_id = $1 limit 1)`,
        [flooded],
      );
      const started = performance.now();
      const { rowCount } = await client.query(
        "update app.webhook_deliveries set processed_at = now(), outcome = 'test' where installation_id = $1 and processed_at is null and parked_at is null",
        [flooded],
      );
      expect(rowCount).toBe(20_000);
      expect(performance.now() - started).toBeLessThan(10_000);
    } finally {
      await client.end();
    }
  }, 60_000);

  it("a claim waiting on the claim lock gives up after its statement timeout", async () => {
    const holder = await superuser.connect();
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended('rocky.worker.claim_webhook_deliveries', 0))",
      );
      const started = Date.now();
      const error = await worker
        .claimWebhookDeliveries({
          forge: "github",
          eventTypes: [...INSTALLATION_TYPES],
          limit: 1,
          leaseSeconds: 60,
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(WebhookInboxError);
      expect((error as WebhookInboxError).code).toBe("57014");
      expect(Date.now() - started).toBeLessThan(CLAIM_STATEMENT_TIMEOUT_MS + 2_000);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  }, 20_000);

  it("leases from the moment of the claim (clock_timestamp), not from when the claim started waiting", async () => {
    await drain();
    const d = installationDelivery();
    await server.recordWebhookDelivery(d);
    const holder = await superuser.connect();
    let claimed: ClaimedDelivery[];
    try {
      await holder.query("begin");
      await holder.query(
        "select pg_advisory_xact_lock(hashtextextended('rocky.worker.claim_webhook_deliveries', 0))",
      );
      const pending = worker.claimWebhookDeliveries({
        forge: "github",
        eventTypes: [...INSTALLATION_TYPES],
        limit: 10,
        leaseSeconds: 60,
      });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await holder.query("rollback");
      claimed = await pending;
    } finally {
      holder.release();
    }
    const row = claimed.find((r) => r.deliveryId === d.deliveryId);
    expect(row).toBeDefined();
    expect(+row!.leaseUntil - Date.now()).toBeGreaterThan(59_000);
    for (const r of claimed) await worker.completeWebhookDelivery(r, "test");
  }, 20_000);
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
