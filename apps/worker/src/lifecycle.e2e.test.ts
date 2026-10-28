import { randomBytes, randomUUID } from "node:crypto";
import {
  nothingStoredYet,
  type ExternalTenantStore,
  type OrgErasers,
  type OrgId,
} from "@rocky-reviews/core";
import {
  beginOrgErasure,
  createDb,
  insertInstallationOrg,
  schema,
  WEBHOOK_MAX_STRIKES,
  type Db,
} from "@rocky-reviews/db";
import {
  CONTAINER_TIMEOUT_MS,
  seedOrg,
  startPostgres,
  type TestPostgres,
  ignoreIdleError,
} from "@rocky-reviews/db/testing";
import {
  createGitHubInstallationReader,
  createGitHubWebhookIngress,
  githubEndpoints,
  parseGitHubAppAuth,
} from "@rocky-reviews/forge-github";
import {
  fakeGitHubApi,
  FIXTURE_APP_ID,
  installationPayload,
  PLANTED,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
  testAppKeys,
  type FakeGitHubApi,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import { buildApp } from "@rocky-reviews/server/app";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppCheck, type AppCheck } from "./app-check.js";
import { sweepOrgDeletions } from "./deletion-sweep.js";
import { drainInstallationEvents, leaseSecondsFor } from "./inbox.js";
import { CONTRADICTION_ATTEMPTS } from "./installations.js";

/**
 * P3-3 end to end: a signed webhook into `POST /webhooks/github` → the inbox (server login) →
 * the worker claims it (worker login) → GitHub re-verification (fixtures in the shape GitHub
 * documents, with synthetic ids, in packages/forge-github/fixtures, served by a fake that checks
 * the app JWT; not recorded from GitHub yet) → org created, deletion scheduled, cancelled,
 * executed. Webhook payloads are built by `packages/forge-github/src/testing.ts`. Real Postgres,
 * real roles, real RLS.
 */

const DAY = 86_400_000;

let pgs: TestPostgres;
let superuser: pg.Pool;
let serverDb: Db;
let workerDb: Db;
let app: ReturnType<typeof buildApp>;
let github: FakeGitHubApi;
let reader: ReturnType<typeof createGitHubInstallationReader>;
let appCheck: AppCheck;
const keys = testAppKeys();
const logLines: string[] = [];
const log = createLogger("worker-e2e", {
  level: "debug",
  destination: { write: (line: string) => void logLines.push(line) },
});
const erased: { store: ExternalTenantStore; orgId: string }[] = [];
const spyEraser = <S extends ExternalTenantStore>(store: S) => ({
  ...nothingStoredYet(store),
  eraseOrg: (orgId: OrgId) => {
    erased.push({ store, orgId });
    return Promise.resolve();
  },
});
const erasers: OrgErasers = {
  object_storage: spyEraser("object_storage"),
  embeddings: spyEraser("embeddings"),
};

const newOrgId = () => randomUUID() as OrgId;
const clock = { now: () => new Date() };
const drain = (db: Db = workerDb) =>
  drainInstallationEvents({ db, forge: reader, appCheck, log, newOrgId, batchSize: 10 });
const sweep = (db: Db = workerDb, with_: OrgErasers = erasers) =>
  sweepOrgDeletions({ db, forge: reader, appCheck, erasers: with_, log });

/**
 * Drains, then makes every waiting retry due, `rounds` times: enough for a contradiction to be
 * retried CONTRADICTION_ATTEMPTS times before GitHub's answer is final (review round 1, S1).
 */
const drainSettled = async (rounds = CONTRADICTION_ATTEMPTS + 1) => {
  for (let i = 0; i < rounds; i++) {
    await drain();
    await makeRetriesDue();
  }
};

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

const install = (installationId: number, accountId: number, login: string, sender?: number) =>
  post(
    "installation",
    sender === undefined
      ? installationPayload("created", { installationId, accountId, login })
      : {
          ...installationPayload("created", { installationId, accountId, login }),
          sender: { id: sender, login: "installer" },
        },
  );
const uninstall = (installationId: number, accountId: number, login: string) =>
  post("installation", installationPayload("deleted", { installationId, accountId, login }));

const orgOf = async (installationId: number) =>
  (
    await superuser.query<{
      id: string;
      account_id: string;
      login: string;
      kind: string;
      installer_forge_user_id: string | null;
      delete_after: Date | null;
    }>(
      `select id, account_id::text, login, kind, installer_forge_user_id::text, delete_after
         from orgs where installation_id = $1`,
      [installationId],
    )
  ).rows[0];

const inboxRow = async (deliveryId: string) =>
  (
    await superuser.query<{
      outcome: string | null;
      processed: boolean;
      parked: boolean;
      attempts: number;
      strikes: number;
      last_error: string | null;
    }>(
      `select outcome, processed_at is not null as processed, parked_at is not null as parked,
              attempts, strikes, last_error
         from app.webhook_deliveries where delivery_id = $1`,
      [deliveryId],
    )
  ).rows[0];

const auditActions = async (orgId: string) =>
  (
    await superuser.query<{ action: string; actor_type: string; actor_id: string }>(
      "select action, actor_type, actor_id from audit_events where org_id = $1 order by id",
      [orgId],
    )
  ).rows;

/** Time travel: move a scheduled deletion `days` into the past (both org triggers held off). */
const advanceGrace = async (orgId: string, days: number): Promise<void> => {
  const client = await superuser.connect();
  try {
    await client.query("begin");
    await client.query("alter table orgs disable trigger user");
    await client.query(
      "update orgs set delete_after = delete_after - $2::float8 * interval '1 day' where id = $1",
      [orgId, days],
    );
    await client.query("alter table orgs enable trigger user");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
};

/** Retries waiting on their backoff become due now (time travel for the inbox). */
const makeRetriesDue = () =>
  superuser.query(
    "update app.webhook_deliveries set available_at = now() where processed_at is null and parked_at is null",
  );

/** Every column holding an org id, any schema (the tombstone excepted, see deletion.test.ts). */
const orgIdHolders = async () =>
  (
    await superuser.query<{ table: string; column: string }>(
      `select format('%I.%I', table_schema, table_name) as "table", column_name as "column"
         from information_schema.columns
        where column_name = 'org_id' and table_schema not in ('pg_catalog', 'information_schema')
          and (table_schema, table_name) <> ('app', 'org_deletions')
       union select 'public.orgs', 'id'`,
    )
  ).rows;

const rowsFor = async (orgId: string) => {
  const counts: Record<string, number> = {};
  for (const h of await orgIdHolders()) {
    const { rows } = await superuser.query<{ n: string }>(
      `select count(*)::text as n from ${h.table} where ${h.column} = $1`,
      [orgId],
    );
    counts[h.table] = Number(rows[0]?.n);
  }
  return counts;
};

/** Plants rows the shape CHECK now refuses, as if they predated it; restores the CHECK after. */
const withoutShapeCheck = async (fn: () => Promise<void>, cleanup: string[]) => {
  const def = await superuser.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'webhook_deliveries_installation_shape'`,
  );
  expect(def.rows).toHaveLength(1);
  await superuser.query(
    "alter table app.webhook_deliveries drop constraint webhook_deliveries_installation_shape",
  );
  try {
    await fn();
  } finally {
    await superuser.query("delete from app.webhook_deliveries where delivery_id = any($1)", [
      cleanup,
    ]);
    await superuser.query(
      `alter table app.webhook_deliveries add constraint webhook_deliveries_installation_shape ${def.rows[0]!.def}`,
    );
  }
};

const plant = async (deliveryId: string, event: Record<string, unknown>) => {
  await superuser.query(
    `insert into app.webhook_deliveries
       (forge, delivery_id, payload_sha256, event_type, installation_id, event)
     values ('github', $1, sha256(convert_to($1, 'utf8')), $2, $3, $4::jsonb)`,
    [deliveryId, event["type"], event["installationId"], JSON.stringify(event)],
  );
};

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
  reader = createGitHubInstallationReader({
    auth: parseGitHubAppAuth({ appId: String(FIXTURE_APP_ID), privateKey: keys.privateKeyPem }),
    api: githubEndpoints({}).api,
    clock: { now: () => new Date() },
    fetch: github.fetch,
  });
  appCheck = createAppCheck({ forge: reader, clock, log });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await serverDb?.close();
  await workerDb?.close();
  await superuser?.end();
  await pgs?.stop();
});

beforeEach(async () => {
  // Each test starts with an empty queue of claimable installation events.
  await superuser.query(
    "update app.webhook_deliveries set processed_at = now(), outcome = 'reset', lease_token = null, lease_until = null where processed_at is null and parked_at is null",
  );
});

describe("install → org (signed webhook → inbox → worker → GitHub → org)", () => {
  it("creates the org from GitHub's answer, records the installer as a candidate, audits it", async () => {
    github.install(4242, { id: 9001, login: "acme", type: "Organization" });
    const { status, deliveryId } = await install(4242, 9001, "acme");
    expect(status).toBe(202);

    const report = await drain();
    expect(report).toEqual({ claimed: 1, processed: 1, retried: 0, parked: 0, lost: 0 });
    const org = await orgOf(4242);
    expect(org).toMatchObject({
      account_id: "9001",
      login: "acme",
      kind: "organization",
      installer_forge_user_id: "5", // the payload's sender: a candidate, not a member
      delete_after: null,
    });
    expect(await inboxRow(deliveryId)).toMatchObject({
      outcome: "org_created",
      processed: true,
      attempts: 1,
    });
    expect(await auditActions(org!.id)).toEqual([
      { action: "org.installed", actor_type: "forge", actor_id: deliveryId },
    ]);
    // No user account or membership is created (P7-1 owns those).
    const members = await superuser.query("select 1 from members where org_id = $1", [org!.id]);
    expect(members.rowCount).toBe(0);
    // GitHub was asked as the app, with a valid JWT.
    expect(github.requests.at(-1)).toEqual({
      method: "GET",
      path: "/app/installations/4242",
      authorized: true,
    });
    // Processed once: nothing more to claim, and GitHub's redelivery is a duplicate.
    expect((await drain()).claimed).toBe(0);
  });

  it("handles an unknown installer (sender: null) and an installer whose event disagrees with GitHub", async () => {
    github.install(4300, { id: 9300, login: "nosender", type: "User" });
    await post("installation", {
      ...installationPayload("created", {
        installationId: 4300,
        accountId: 9300,
        login: "nosender",
        type: "User",
      }),
      sender: null,
    });
    // A planted row claims another account for installation 4301: GitHub's account wins and the
    // sender is not trusted as installer.
    github.install(4301, { id: 9301, login: "real-owner", type: "Organization" });
    await install(4301, 6666, "attacker-org", 6666);
    expect((await drain()).processed).toBe(2);
    expect(await orgOf(4300)).toMatchObject({ kind: "user", installer_forge_user_id: null });
    expect(await orgOf(4301)).toMatchObject({
      account_id: "9301",
      login: "real-owner",
      installer_forge_user_id: null,
    });
  });
});

describe("uninstall → scheduled → grace elapses → sweep → erased everywhere", () => {
  it("schedules with a 7-day grace, then empties every tenant table and leaves a tombstone", async () => {
    github.install(5000, { id: 9500, login: "leaving", type: "Organization" });
    await install(5000, 9500, "leaving");
    await drain();
    const org = await orgOf(5000);
    // Tenant data in every table.
    const leaving = await seedOrg(workerDb, org!.id as OrgId, { orgExists: true });
    const control = await seedOrg(workerDb, newOrgId(), { installationId: 5999 });
    // P7-1: a signed-in member of each org (session links hold an org id too).
    const { userId } = await workerDb.sessions.upsertUser("github", 1001, new Date());
    for (const seeded of [leaving, control]) {
      const now = new Date();
      await workerDb.sessions.createSession({
        tokenSha256: randomBytes(32),
        userId,
        orgs: [{ orgId: seeded.orgId, memberId: seeded.memberId }],
        activeOrgId: seeded.orgId,
        now,
        idleTimeoutSeconds: 3600,
        expiresAt: new Date(now.getTime() + 3_600_000),
      });
    }
    const before = await rowsFor(org!.id);
    for (const [table, n] of Object.entries(before)) expect(n, table).toBeGreaterThan(0);

    github.uninstall(5000);
    const { deliveryId } = await uninstall(5000, 9500, "leaving");
    expect((await drain()).processed).toBe(1);
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "deletion_scheduled" });
    const scheduled = await orgOf(5000);
    expect(scheduled!.delete_after!.getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY);
    expect(scheduled!.delete_after!.getTime()).toBeLessThan(Date.now() + 7.1 * DAY);
    expect((await auditActions(org!.id)).map((a) => a.action)).toEqual(
      expect.arrayContaining(["org.installed", "org.uninstalled", "org.deletion_scheduled"]),
    );

    // Inside the grace period nothing is erased.
    expect(await sweep()).toMatchObject({ due: 0, deleted: 0 });
    await advanceGrace(org!.id, 6);
    expect(await sweep()).toMatchObject({ due: 0, deleted: 0 });
    // Past seven days the sweep erases it, external stores first.
    await advanceGrace(org!.id, 1.01);
    erased.length = 0;
    expect(await sweep()).toEqual({
      due: 1,
      deleted: 1,
      cancelled: 0,
      deferred: 0,
      skipped: 0,
      failed: 0,
    });
    expect(erased).toEqual([
      { store: "object_storage", orgId: org!.id },
      { store: "embeddings", orgId: org!.id },
    ]);
    for (const [table, n] of Object.entries(await rowsFor(org!.id))) expect(n, table).toBe(0);
    for (const [table, n] of Object.entries(await rowsFor(control.orgId))) {
      expect(n, `control ${table}`).toBeGreaterThan(0);
    }
    // Erasure evidence; the org's finished inbox rows are gone too.
    const tombstone = await superuser.query(
      "select installation_id::text from app.org_deletions where org_id = $1",
      [org!.id],
    );
    expect(tombstone.rows).toEqual([{ installation_id: "5000" }]);
    expect(await inboxRow(deliveryId)).toBeUndefined();
    // A second sweep finds nothing.
    expect(await sweep()).toEqual({
      due: 0,
      deleted: 0,
      cancelled: 0,
      deferred: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("keeps the org when an external store fails, and erases it on the next sweep", async () => {
    github.install(5100, { id: 9510, login: "flaky", type: "Organization" });
    await install(5100, 9510, "flaky");
    await drain();
    github.uninstall(5100);
    await uninstall(5100, 9510, "flaky");
    await drain();
    const org = await orgOf(5100);
    await advanceGrace(org!.id, 8);
    let fail = true;
    const failing: OrgErasers = {
      ...erasers,
      object_storage: {
        store: "object_storage",
        eraseOrg: () => (fail ? Promise.reject(new Error("r2 down")) : Promise.resolve()),
      },
    };
    expect(await sweep(workerDb, failing)).toMatchObject({ failed: 1, deleted: 0 });
    expect(await orgOf(5100)).toBeDefined();
    // Marked erasing before the stores were touched (S6): the next sweep resumes, no re-check.
    const erasing = await superuser.query<{ erasing: boolean }>(
      "select erasing_at is not null as erasing from orgs where id = $1",
      [org!.id],
    );
    expect(erasing.rows[0]?.erasing).toBe(true);
    fail = false;
    const asked = github.requests.length;
    expect(await sweep(workerDb, failing)).toMatchObject({ deleted: 1 });
    expect(github.requests.slice(asked).filter((r) => r.path !== "/app")).toEqual([]);
    expect(await orgOf(5100)).toBeUndefined();
  });

  it("two workers sweeping at once erase each org once", async () => {
    const ids: string[] = [];
    for (const n of [0, 1, 2, 3]) {
      github.install(5200 + n, { id: 9520 + n, login: `swept-${n}`, type: "Organization" });
      await install(5200 + n, 9520 + n, `swept-${n}`);
    }
    await drain();
    for (const n of [0, 1, 2, 3]) {
      github.uninstall(5200 + n);
      await uninstall(5200 + n, 9520 + n, `swept-${n}`);
    }
    await drain();
    for (const n of [0, 1, 2, 3]) {
      const org = await orgOf(5200 + n);
      ids.push(org!.id);
      await advanceGrace(org!.id, 8);
    }
    const other = createDb({ connectionString: pgs.workerUrl, max: 2 });
    try {
      const reports = await Promise.all([sweep(), sweep(other)]);
      expect(reports.reduce((n, r) => n + r.deleted, 0)).toBe(4);
      expect(reports.reduce((n, r) => n + r.failed, 0)).toBe(0);
    } finally {
      await other.close();
    }
    const tombstones = await superuser.query(
      "select count(*)::int as n from app.org_deletions where org_id = any($1)",
      [ids],
    );
    expect(tombstones.rows[0]).toEqual({ n: 4 });
  });
});

describe("reinstall", () => {
  it("within the grace period, with a new installation id for the same account, cancels the deletion and keeps the data", async () => {
    github.install(6000, { id: 9600, login: "comeback", type: "Organization" });
    await install(6000, 9600, "comeback");
    await drain();
    const org = await orgOf(6000);
    await seedOrg(workerDb, org!.id as OrgId, { orgExists: true });
    github.uninstall(6000);
    await uninstall(6000, 9600, "comeback");
    await drain();
    expect((await orgOf(6000))?.delete_after).not.toBeNull();

    github.install(6001, { id: 9600, login: "comeback-renamed", type: "Organization" });
    const { deliveryId } = await install(6001, 9600, "comeback-renamed");
    expect((await drain()).processed).toBe(1);
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "org_rebound" });
    expect(await orgOf(6000)).toBeUndefined();
    const rebound = await orgOf(6001);
    expect(rebound).toMatchObject({ id: org!.id, login: "comeback-renamed", delete_after: null });
    expect((await auditActions(org!.id)).map((a) => a.action)).toEqual(
      expect.arrayContaining(["org.deletion_cancelled", "org.reinstalled"]),
    );
    // Nothing is due any more, and the data is still there.
    expect((await workerDb.orgsDueForDeletion(100)).map((o) => o.orgId)).not.toContain(org!.id);
    expect((await rowsFor(org!.id))["public.repos"]).toBe(1);
  });

  it("with the same installation id (a redelivery after GitHub briefly answered 404) cancels it", async () => {
    github.install(6100, { id: 9610, login: "blip", type: "Organization" });
    await install(6100, 9610, "blip");
    await drain();
    github.uninstall(6100);
    await uninstall(6100, 9610, "blip");
    await drain();
    expect((await orgOf(6100))?.delete_after).not.toBeNull();
    github.install(6100, { id: 9610, login: "blip", type: "Organization" });
    // A new delivery body for the same installation (GitHub redelivers with a new id/body).
    const { deliveryId } = await install(6100, 9610, "blip", 77);
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "org_reinstalled" });
    expect((await orgOf(6100))?.delete_after).toBeNull();
  });

  it("after the deletion ran, creates a new org: nothing of the old one comes back", async () => {
    github.install(6200, { id: 9620, login: "again", type: "Organization" });
    await install(6200, 9620, "again");
    await drain();
    const first = await orgOf(6200);
    github.uninstall(6200);
    await uninstall(6200, 9620, "again");
    await drain();
    await advanceGrace(first!.id, 8);
    await sweep();
    github.install(6201, { id: 9620, login: "again", type: "Organization" });
    const { deliveryId } = await install(6201, 9620, "again");
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "org_created" });
    const second = await orgOf(6201);
    expect(second!.id).not.toBe(first!.id);
    expect(await auditActions(second!.id)).toEqual([
      { action: "org.installed", actor_type: "forge", actor_id: deliveryId },
    ]);
  });
});

describe("negative cases", () => {
  it("a forged delivery is refused at the door; a planted row for an installation GitHub does not know creates nothing", async () => {
    const forged = signedDelivery(
      "installation",
      installationPayload("created", { installationId: 7000 }),
      {
        secret: "not-the-secret".padEnd(40, "x"),
      },
    );
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: forged.headers,
      payload: forged.body,
    });
    expect(response.statusCode).toBe(401);

    // Whoever holds the server's database credential can plant inbox rows directly.
    const planted = {
      forge: "github" as const,
      deliveryId: randomUUID(),
      payloadSha256: "ab".repeat(32),
      event: {
        type: "installation.created" as const,
        installationId: 7001,
        account: { id: 9700, login: "planted", kind: "organization" as const },
        sender: { id: 1, login: "attacker" },
      },
    };
    expect(await serverDb.recordWebhookDelivery(planted)).toBe("queued");
    await drainSettled();
    expect(await inboxRow(planted.deliveryId)).toMatchObject({
      outcome: "installation_not_found",
      processed: true,
      attempts: CONTRADICTION_ATTEMPTS,
    });
    expect(await orgOf(7001)).toBeUndefined();
    expect(await workerDb.installationOrgs("github", 7001, 9700)).toEqual([]);
  });

  it("an installation.deleted while GitHub still has the installation (active or suspended) deletes nothing", async () => {
    github.install(7100, { id: 9710, login: "stays", type: "Organization" });
    await install(7100, 9710, "stays");
    await drain();
    const { deliveryId } = await uninstall(7100, 9710, "stays");
    await drainSettled();
    expect(await inboxRow(deliveryId)).toMatchObject({
      outcome: "installation_exists",
      attempts: CONTRADICTION_ATTEMPTS,
    });
    expect((await orgOf(7100))?.delete_after).toBeNull();

    // Suspended is not deleted.
    github.install(7100, { id: 9710, login: "stays", type: "Organization" }, { suspended: true });
    const suspended = await post("installation", {
      ...installationPayload("deleted", { installationId: 7100, accountId: 9710, login: "stays" }),
      sender: { id: 8, login: "suspender" },
    });
    await drainSettled();
    expect(await inboxRow(suspended.deliveryId)).toMatchObject({ outcome: "installation_exists" });
    expect((await orgOf(7100))?.delete_after).toBeNull();
    const org = await orgOf(7100);
    expect(
      (await auditActions(org!.id)).filter((a) => a.action === "org.uninstall_ignored"),
    ).toHaveLength(2);
  });

  it("a GitHub outage or a rejected app key is never read as an uninstall", async () => {
    github.install(7200, { id: 9720, login: "outage", type: "Organization" });
    await install(7200, 9720, "outage");
    await drain();
    github.uninstall(7200);
    github.failNext(503);
    const { deliveryId } = await uninstall(7200, 9720, "outage");
    expect(await drain()).toMatchObject({ retried: 1, processed: 0 });
    expect(await inboxRow(deliveryId)).toMatchObject({
      last_error: "forge_http_503",
      processed: false,
    });
    expect((await orgOf(7200))?.delete_after).toBeNull();

    // A worker with a key GitHub does not accept fails the app check (401) and claims nothing
    // (review round 1, M2): still nothing deleted, and the row is not even touched.
    const wrongKey = testAppKeys();
    const badReader = createGitHubInstallationReader({
      auth: parseGitHubAppAuth({
        appId: String(FIXTURE_APP_ID),
        privateKey: wrongKey.privateKeyPem,
      }),
      api: githubEndpoints({}).api,
      clock,
      fetch: github.fetch,
    });
    await makeRetriesDue();
    expect(
      await drainInstallationEvents({
        db: workerDb,
        forge: badReader,
        appCheck: createAppCheck({ forge: badReader, clock, log }),
        log,
        newOrgId,
      }),
    ).toMatchObject({ claimed: 0 });
    expect(await inboxRow(deliveryId)).toMatchObject({
      last_error: "forge_http_503",
      attempts: 1,
      strikes: 0,
      processed: false,
    });
    expect((await orgOf(7200))?.delete_after).toBeNull();

    // Once GitHub answers, the uninstall goes through.
    await makeRetriesDue();
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({
      outcome: "deletion_scheduled",
      attempts: 2,
    });
  });

  it("concurrent workers process every row exactly once and create one org per installation", async () => {
    const installations = Array.from({ length: 12 }, (_, i) => 8000 + i);
    for (const id of installations) {
      github.install(id, { id: id + 10_000, login: `con-${id}`, type: "Organization" });
      await install(id, id + 10_000, `con-${id}`);
      // A second, different delivery for the first four (e.g. a redelivery with a new body).
      if (id < 8004) await install(id, id + 10_000, `con-${id}`, 99);
    }
    const workers = Array.from({ length: 4 }, () =>
      createDb({ connectionString: pgs.workerUrl, max: 2 }),
    );
    try {
      for (let round = 0; round < 4; round++) {
        await Promise.all(workers.map((w) => drain(w).then(() => drain(w))));
        await makeRetriesDue(); // a unique-violation loser retries later
      }
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
    for (const id of installations) {
      const { rows } = await superuser.query("select id from orgs where installation_id = $1", [
        id,
      ]);
      expect(rows, String(id)).toHaveLength(1);
      const installed = (await auditActions((rows[0] as { id: string }).id)).filter(
        (a) => a.action === "org.installed",
      );
      expect(installed, String(id)).toHaveLength(1);
    }
    const { rows } = await superuser.query<{ outcome: string; n: number }>(
      `select outcome, count(*)::int as n from app.webhook_deliveries
        where installation_id between 8000 and 8011 group by 1 order by 1`,
    );
    // Review round 3: the second delivery for an installation, received before the first one's
    // claim, is collapsed into the first one's GitHub-verified outcome when it completes (never at
    // claim time, review round 2 A).
    // GitHub (review round 1, L5); before, it was claimed and found "already_installed".
    expect(rows).toEqual([
      { outcome: "org_created", n: 12 },
      { outcome: "superseded", n: 4 },
    ]);
  });

  it("a worker that crashes mid-processing loses nothing: the lease expires and the row is retried", async () => {
    github.install(8100, { id: 9810, login: "crash", type: "Organization" });
    const { deliveryId } = await install(8100, 9810, "crash");
    // A worker claims the row and dies before finishing.
    const [claimed] = await workerDb.claimWebhookDeliveries({
      forge: "github",
      eventTypes: ["installation.created", "installation.deleted"],
      limit: 10,
      leaseSeconds: 300,
    });
    expect(claimed?.deliveryId).toBe(deliveryId);
    expect((await drain()).claimed).toBe(0); // leased to the dead worker
    expect(await orgOf(8100)).toBeUndefined();
    await superuser.query(
      "update app.webhook_deliveries set lease_until = now() - interval '1 second' where delivery_id = $1",
      [deliveryId],
    );
    expect((await drain()).processed).toBe(1);
    expect(await inboxRow(deliveryId)).toMatchObject({
      outcome: "org_created",
      attempts: 2,
      last_error: "lease_expired",
    });
    expect(await orgOf(8100)).toBeDefined();
    // The dead worker cannot finish it afterwards.
    expect(await workerDb.completeWebhookDelivery(claimed!, "late")).toBe(false);
  });

  it("parks poison rows: bounded strikes on repeated bad answers, at once when a row cannot succeed", async () => {
    // GitHub answers this installation with something that is not GitHub's JSON every time (an
    // outage would be transient and never park, review round 1 S3; see the outage test below).
    github.install(8200, { id: 9820, login: "poison", type: "Organization" });
    const poison = await install(8200, 9820, "poison");
    for (let i = 0; i < WEBHOOK_MAX_STRIKES + 2; i++) {
      // Fail every attempt; once parked, further drains must not even ask GitHub.
      if ((await inboxRow(poison.deliveryId))?.parked !== true) {
        github.failNext(200, 1, { body: "<html>maintenance</html>", contentType: "text/html" });
      }
      await makeRetriesDue();
      await drain();
    }
    expect(await inboxRow(poison.deliveryId)).toMatchObject({
      parked: true,
      processed: false,
      attempts: WEBHOOK_MAX_STRIKES,
      strikes: WEBHOOK_MAX_STRIKES,
      last_error: "forge_invalid_response",
    });
    expect(await orgOf(8200)).toBeUndefined();

    // A stored row that no longer decodes (tampered in place) is parked on the first claim. The
    // shape CHECK (review round 2) refuses such a row now; lift it, as for a row predating it.
    const tampered = await install(8201, 9821, "tampered");
    await withoutShapeCheck(async () => {
      await superuser.query(
        `update app.webhook_deliveries
            set event = jsonb_set(event, '{account,login}', '"../../etc"') where delivery_id = $1`,
        [tampered.deliveryId],
      );
      await drain();
      expect(await inboxRow(tampered.deliveryId)).toMatchObject({
        parked: true,
        attempts: 1,
        last_error: "invalid_event",
      });
    }, [tampered.deliveryId]);

    // GitHub says the installation belongs to another account than the org bound to it.
    github.install(8202, { id: 9822, login: "owner", type: "Organization" });
    await install(8202, 9822, "owner");
    await drain();
    github.install(8202, { id: 9999, login: "someone-else", type: "Organization" });
    const mismatch = await install(8202, 9999, "someone-else", 42);
    await drain();
    expect(await inboxRow(mismatch.deliveryId)).toMatchObject({
      parked: true,
      last_error: "account_mismatch",
    });
    expect(await orgOf(8202)).toMatchObject({ account_id: "9822", login: "owner" });
  });

  it("keeps tenants apart: the server's login sees only its own org's lifecycle", async () => {
    github.install(8300, { id: 9830, login: "tenant-a", type: "Organization" });
    github.install(8301, { id: 9831, login: "tenant-b", type: "Organization" });
    await install(8300, 9830, "tenant-a");
    await install(8301, 9831, "tenant-b");
    await drain();
    const a = (await orgOf(8300))!.id as OrgId;
    const b = (await orgOf(8301))!.id as OrgId;
    const seen = await serverDb.withOrg(a, async (tx) => ({
      orgs: (await tx.db.select({ id: schema.orgs.id }).from(schema.orgs)).map((r) => r.id),
      audit: (await tx.db.select({ org: schema.auditEvents.orgId }).from(schema.auditEvents)).map(
        (r) => r.org,
      ),
    }));
    expect(seen.orgs).toEqual([a]);
    expect(new Set(seen.audit)).toEqual(new Set([a]));
    // The server's login can neither look up nor erase another tenant's org.
    await expect(serverDb.installationOrgs("github", 8301, null)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(serverDb.deleteOrg(b)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("review round 1", () => {
  const isErasing = async (orgId: string) =>
    (
      await superuser.query<{ erasing: boolean }>(
        "select erasing_at is not null as erasing from orgs where id = $1",
        [orgId],
      )
    ).rows[0]?.erasing;

  const installAndUninstall = async (installationId: number, accountId: number, login: string) => {
    github.install(installationId, { id: accountId, login, type: "Organization" });
    await install(installationId, accountId, login);
    await drain();
    github.uninstall(installationId);
    await uninstall(installationId, accountId, login);
    await drain();
    return (await orgOf(installationId))!;
  };

  it("S1: a created that GitHub's API does not show yet is retried, then creates the org", async () => {
    const { deliveryId } = await install(9000, 9900, "lagging");
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({
      processed: false,
      parked: false,
      attempts: 1,
      strikes: 1,
      last_error: "forge_contradiction",
    });
    github.install(9000, { id: 9900, login: "lagging", type: "Organization" });
    await makeRetriesDue();
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "org_created", attempts: 2 });
  });

  it("S1: a deleted that GitHub still answers 200 for is retried, then schedules the deletion", async () => {
    github.install(9010, { id: 9910, login: "slow-uninstall", type: "Organization" });
    await install(9010, 9910, "slow-uninstall");
    await drain();
    const { deliveryId } = await uninstall(9010, 9910, "slow-uninstall");
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({
      processed: false,
      last_error: "forge_contradiction",
    });
    expect((await orgOf(9010))?.delete_after).toBeNull();
    github.uninstall(9010);
    await makeRetriesDue();
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "deletion_scheduled" });
  });

  it("S2/N6: created and deleted for one installation, out of order and drained concurrently, end consistent", async () => {
    // GitHub delivered the uninstall before the install; by now the installation is gone.
    const deleted = await uninstall(9020, 9920, "flapping");
    const created = await install(9020, 9920, "flapping");
    await superuser.query(
      "update app.webhook_deliveries set received_at = received_at - interval '1 second' where delivery_id = $1",
      [deleted.deliveryId],
    );
    // Every claim and every finish of this installation's rows, in order. A claim is recorded
    // when it returned and a finish when it started, so a recorded overlap is a real one.
    const timeline: string[] = [];
    const ours = (r: { installationId: number }) => r.installationId === 9020;
    const traced = (db: Db): Db => ({
      ...db,
      claimWebhookDeliveries: async (options) => {
        const rows = await db.claimWebhookDeliveries(options);
        for (const r of rows.filter(ours)) timeline.push(`claim:${r.deliveryId}`);
        return rows;
      },
      completeWebhookDelivery: (lease, outcome) => {
        timeline.push(`done:${lease.deliveryId}`);
        return db.completeWebhookDelivery(lease, outcome);
      },
      failWebhookDelivery: (lease, failure) => {
        timeline.push(`done:${lease.deliveryId}`);
        return db.failWebhookDelivery(lease, failure);
      },
    });
    const pools = Array.from({ length: 4 }, () =>
      createDb({ connectionString: pgs.workerUrl, max: 1 }),
    );
    try {
      for (let round = 0; round < CONTRADICTION_ATTEMPTS + 2; round++) {
        await Promise.all(pools.map((w) => drain(traced(w))));
        await makeRetriesDue();
      }
    } finally {
      await Promise.all(pools.map((w) => w.close()));
    }
    expect(await inboxRow(deleted.deliveryId)).toMatchObject({ outcome: "no_org", attempts: 1 });
    expect(await inboxRow(created.deliveryId)).toMatchObject({
      outcome: "installation_not_found",
      attempts: CONTRADICTION_ATTEMPTS,
    });
    expect(await orgOf(9020)).toBeUndefined();
    // Strictly one at a time, oldest first: the uninstall, then the install's three attempts.
    const fromTimeline = timeline.filter((e) => e.startsWith("claim:")).map((e) => e.slice(6));
    expect(fromTimeline).toEqual([
      deleted.deliveryId,
      ...Array<string>(CONTRADICTION_ATTEMPTS).fill(created.deliveryId),
    ]);
    for (let i = 0; i < timeline.length; i++) {
      expect(timeline[i]!.split(":")[0], String(i)).toBe(i % 2 === 0 ? "claim" : "done");
    }
  });

  it("S3: a long GitHub outage never parks a row; backoff is capped at an hour; it goes through after", async () => {
    github.install(9030, { id: 9930, login: "outage-long", type: "Organization" });
    await install(9030, 9930, "outage-long");
    await drain();
    github.uninstall(9030);
    const { deliveryId } = await uninstall(9030, 9930, "outage-long");
    const attempts = WEBHOOK_MAX_STRIKES * 2;
    for (let i = 0; i < attempts; i++) {
      github.failNext([503, 502, 429, 403][i % 4]!);
      await makeRetriesDue();
      expect(await drain()).toMatchObject({ claimed: 1, retried: 1, parked: 0 });
    }
    expect(await inboxRow(deliveryId)).toMatchObject({
      parked: false,
      attempts,
      strikes: 0,
    });
    const { rows } = await superuser.query<{ wait: number }>(
      "select extract(epoch from available_at - now())::int as wait from app.webhook_deliveries where delivery_id = $1",
      [deliveryId],
    );
    expect(rows[0]!.wait).toBeLessThanOrEqual(3600);
    expect(rows[0]!.wait).toBeGreaterThan(1800);
    await makeRetriesDue();
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "deletion_scheduled" });
  });

  it("S4/SF3: a row whose lease ran short (by the worker's own clock) is released unstarted, without a hot loop", async () => {
    github.install(9040, { id: 9940, login: "late-row", type: "Organization" });
    const { deliveryId } = await install(9040, 9940, "late-row");
    const asked = github.requests.length;
    // The batch took the whole lease: the first reading (the claim) is now, every later one is
    // a lease later (a slow batch, a paused process).
    const start = Date.now();
    let readings = 0;
    const slow = {
      now: () => new Date(readings++ === 0 ? start : start + leaseSecondsFor(10) * 1000),
    };
    const report = await drainInstallationEvents({
      db: workerDb,
      forge: reader,
      appCheck,
      clock: slow,
      log,
      newOrgId,
      batchSize: 10,
    });
    expect(report).toMatchObject({ claimed: 1, processed: 0, retried: 1 });
    expect(github.requests.slice(asked).filter((r) => r.path !== "/app")).toEqual([]);
    expect(await inboxRow(deliveryId)).toMatchObject({
      processed: false,
      strikes: 0,
      last_error: "lease_budget",
    });
    expect(await orgOf(9040)).toBeUndefined();
    // Released with a delay: an immediate second drain finds nothing (no hot loop).
    expect((await drain()).claimed).toBe(0);
    await makeRetriesDue();
    expect((await drain()).processed).toBe(1);
    expect(await orgOf(9040)).toBeDefined();
  });

  it("SF3: a skewed worker clock or a batch of one still processes rows", async () => {
    github.install(9041, { id: 9941, login: "skewed-behind", type: "Organization" });
    github.install(9042, { id: 9942, login: "single", type: "Organization" });
    github.install(9043, { id: 9943, login: "skewed-ahead", type: "Organization" });
    for (const [installationId, skewMs] of [
      [9041, -3_600_000],
      [9043, 3_600_000],
    ] as const) {
      await install(installationId, installationId + 900, `skew-${installationId}`);
      const report = await drainInstallationEvents({
        db: workerDb,
        forge: reader,
        appCheck,
        clock: { now: () => new Date(Date.now() + skewMs) },
        log,
        newOrgId,
        batchSize: 10,
      });
      expect(report, String(skewMs)).toMatchObject({ claimed: 1, processed: 1, retried: 0 });
      expect(await orgOf(installationId)).toBeDefined();
    }
    await install(9042, 9942, "single");
    expect(
      await drainInstallationEvents({
        db: workerDb,
        forge: reader,
        appCheck,
        log,
        newOrgId,
        batchSize: 1,
      }),
    ).toMatchObject({ claimed: 1, processed: 1, retried: 0 });
    expect(await orgOf(9042)).toBeDefined();
  });

  it("S1c: the sweep re-verifies: GitHub still has it → cancelled and audited; no answer → deferred", async () => {
    const org = await installAndUninstall(9050, 9950, "resurrected");
    await advanceGrace(org.id, 8);
    // GitHub does not answer: nothing happens, the org stays due.
    github.failNext(503);
    expect(await sweep()).toMatchObject({ due: 1, deferred: 1, deleted: 0 });
    expect(await isErasing(org.id)).toBe(false);
    // GitHub has the installation again (or never lost it): the deletion is cancelled.
    github.install(
      9050,
      { id: 9950, login: "resurrected", type: "Organization" },
      { suspended: true },
    );
    erased.length = 0;
    expect(await sweep()).toMatchObject({ due: 1, cancelled: 1, deleted: 0 });
    expect(erased).toEqual([]);
    expect(await orgOf(9050)).toMatchObject({ delete_after: null });
    const audit = await superuser.query<{ action: string; actor: string; metadata: unknown }>(
      `select action, actor_type || ':' || actor_id as actor, metadata from audit_events
        where org_id = $1 and action in ('org.erasure_cancelled', 'org.deletion_cancelled')
        order by id`,
      [org.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["org.erasure_cancelled", "org.deletion_cancelled"]),
    );
    expect(audit.rows.find((r) => r.action === "org.erasure_cancelled")).toMatchObject({
      actor: "system:org_deletion_sweep",
      metadata: { installation_id: 9050, reason: "installation_exists", suspended: true },
    });
  });

  it("S1c/H1: a deadline that reached the database without an uninstall cannot erase a live org", async () => {
    github.install(9060, { id: 9960, login: "planted-deadline", type: "Organization" });
    await install(9060, 9960, "planted-deadline");
    await drain();
    const org = (await orgOf(9060))!;
    await superuser.query("alter table orgs disable trigger user");
    try {
      await superuser.query(
        "update orgs set delete_after = now() - interval '1 day' where id = $1",
        [org.id],
      );
    } finally {
      await superuser.query("alter table orgs enable trigger user");
    }
    expect(await sweep()).toMatchObject({ cancelled: 1, deleted: 0 });
    expect(await orgOf(9060)).toMatchObject({ id: org.id, delete_after: null });
  });

  it("S6: a reinstall after erasing started gets a fresh org; the old one is still erased", async () => {
    const old = await installAndUninstall(9070, 9970, "erasing");
    await advanceGrace(old.id, 8);
    const failing: OrgErasers = {
      ...erasers,
      embeddings: { store: "embeddings", eraseOrg: () => Promise.reject(new Error("down")) },
    };
    expect(await sweep(workerDb, failing)).toMatchObject({ failed: 1 });
    expect(await isErasing(old.id)).toBe(true);

    // The account installs the app again (GitHub issues a new installation id).
    github.install(9071, { id: 9970, login: "erasing", type: "Organization" });
    const { deliveryId } = await install(9071, 9970, "erasing");
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "org_created" });
    const fresh = (await orgOf(9071))!;
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.delete_after).toBeNull();
    expect(await isErasing(old.id)).toBe(true);

    expect(await sweep()).toMatchObject({ deleted: 1 });
    expect(await orgOf(9070)).toBeUndefined();
    expect(await orgOf(9071)).toMatchObject({ id: fresh.id, delete_after: null });
  });

  it("M2: a key for another app claims nothing and erases nothing, and says so in the log", async () => {
    const due = await installAndUninstall(9080, 9980, "wrong-app");
    await advanceGrace(due.id, 8);
    github.install(9081, { id: 9981, login: "waiting", type: "Organization" });
    const { deliveryId } = await install(9081, 9981, "waiting");
    github.reportAppId(FIXTURE_APP_ID + 7);
    const before = logLines.length;
    try {
      const check = createAppCheck({ forge: reader, clock, log });
      expect(
        await drainInstallationEvents({
          db: workerDb,
          forge: reader,
          appCheck: check,
          log,
          newOrgId,
        }),
      ).toMatchObject({ claimed: 0 });
      expect(
        await sweepOrgDeletions({ db: workerDb, forge: reader, appCheck: check, erasers, log }),
      ).toMatchObject({ due: 0, deleted: 0 });
    } finally {
      github.reportAppId(FIXTURE_APP_ID);
    }
    expect(await inboxRow(deliveryId)).toMatchObject({ attempts: 0, processed: false });
    expect(await orgOf(9080)).toMatchObject({ id: due.id });
    const failure = logLines
      .slice(before)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => String(l["msg"]).startsWith("forge app check failed"));
    expect(failure).toMatchObject({ level: 50, errorCode: "forge_app_mismatch" });
    // With the right app, both go ahead.
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "org_created" });
    expect(await sweep()).toMatchObject({ deleted: 1 });
  });

  it("M3: a worker claims only its forge's rows, and refuses a foreign row without asking GitHub", async () => {
    const gitlab = {
      forge: "gitlab" as const,
      deliveryId: randomUUID(),
      payloadSha256: "cd".repeat(32),
      event: {
        type: "installation.created" as const,
        installationId: 9090,
        account: { id: 9990, login: "elsewhere", kind: "organization" as const },
        sender: null,
      },
    };
    expect(await serverDb.recordWebhookDelivery(gitlab)).toBe("queued");
    expect((await drain()).claimed).toBe(0);
    expect(await inboxRow(gitlab.deliveryId)).toMatchObject({ attempts: 0 });

    // Even if a claim returned one (a bug, a replaced function), it is refused before GitHub.
    github.install(9091, { id: 9991, login: "relabelled", type: "Organization" });
    const { deliveryId } = await install(9091, 9991, "relabelled");
    const relabelling: Db = {
      ...workerDb,
      claimWebhookDeliveries: async (options) =>
        (await workerDb.claimWebhookDeliveries(options)).map((r) => ({ ...r, forge: "gitlab" })),
    };
    const asked = github.requests.length;
    expect(await drain(relabelling)).toMatchObject({ claimed: 1, processed: 0 });
    expect(github.requests.slice(asked).filter((r) => r.path !== "/app")).toEqual([]);
    expect(await orgOf(9091)).toBeUndefined();
    // The relabelled lease matches no stored row, so nothing was recorded against the real one;
    // it is retried once its lease expires.
    expect(await inboxRow(deliveryId)).toMatchObject({ processed: false, parked: false });
  });
});

describe("review round 2", () => {
  it("A: a newer undecodable duplicate cannot swallow a genuine uninstall or install", async () => {
    github.install(9120, { id: 19120, login: "genuine", type: "Organization" });
    await install(9120, 19120, "genuine");
    await drain();
    github.uninstall(9120);
    const genuineDeleted = await uninstall(9120, 19120, "genuine");
    github.install(9121, { id: 19121, login: "new-tenant", type: "Organization" });
    const genuineCreated = await install(9121, 19121, "new-tenant");
    const planted = [randomUUID(), randomUUID()];
    await withoutShapeCheck(async () => {
      await plant(planted[0]!, { type: "installation.deleted", installationId: 9120 });
      await plant(planted[1]!, { type: "installation.created", installationId: 9121 });
      await drainSettled();
      expect(await inboxRow(genuineDeleted.deliveryId)).toMatchObject({
        outcome: "deletion_scheduled",
      });
      expect(await inboxRow(genuineCreated.deliveryId)).toMatchObject({ outcome: "org_created" });
      // The planted rows were received before the genuine rows were claimed: they are answered
      // by the genuine rows' GitHub-verified outcomes (collapse on completion, review round 3)
      // and never decided anything themselves.
      for (const id of planted) {
        expect(await inboxRow(id)).toMatchObject({
          processed: true,
          outcome: "superseded",
          attempts: 0,
        });
      }
    }, planted);
    expect((await orgOf(9120))?.delete_after).not.toBeNull();
    expect(await orgOf(9121)).toBeDefined();
  });

  it("A: the receiver's role cannot store an installation row without the decodable shape", async () => {
    const { rows } = await superuser.query<{ validated: boolean }>(
      `select convalidated as validated from pg_constraint
        where conname = 'webhook_deliveries_installation_shape'`,
    );
    expect(rows).toEqual([{ validated: true }]);
    const planted = {
      forge: "github" as const,
      deliveryId: randomUUID(),
      payloadSha256: "ef".repeat(32),
      event: { type: "installation.deleted", installationId: 9122 },
    };
    const app = new pg.Pool({ connectionString: pgs.appUrl, max: 1 }).on("error", ignoreIdleError);
    try {
      await expect(
        app.query(
          `insert into app.webhook_deliveries
             (forge, delivery_id, payload_sha256, event_type, installation_id, event)
           values ('github', $1, $2, 'installation.deleted', 9122, $3::jsonb)`,
          [
            planted.deliveryId,
            Buffer.from(planted.payloadSha256, "hex"),
            JSON.stringify(planted.event),
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await app.end();
    }
  });

  it("C: erasing the old org leaves a reinstall's rows and its installer candidate alone", async () => {
    github.install(9130, { id: 19130, login: "moving", type: "Organization" });
    await install(9130, 19130, "moving");
    await drain();
    github.uninstall(9130);
    await uninstall(9130, 19130, "moving");
    await drain();
    const old = (await orgOf(9130))!;
    await advanceGrace(old.id, 8);
    const failing: OrgErasers = {
      ...erasers,
      embeddings: { store: "embeddings", eraseOrg: () => Promise.reject(new Error("down")) },
    };
    expect(await sweep(workerDb, failing)).toMatchObject({ failed: 1 });

    github.install(9131, { id: 19130, login: "moving", type: "Organization" });
    const created = await install(9131, 19130, "moving");
    await drain();
    const fresh = (await orgOf(9131))!;
    expect(fresh).toMatchObject({ installer_forge_user_id: "5" });
    // A second delivery for the reinstall, still pending when the old org's erasure finishes.
    const pending = await install(9131, 19130, "moving", 77);

    expect(await sweep()).toMatchObject({ deleted: 1 });
    expect(await orgOf(9130)).toBeUndefined();
    expect(await inboxRow(created.deliveryId)).toMatchObject({ outcome: "org_created" });
    const { rows } = await superuser.query<{ sender: unknown; login: string }>(
      `select event -> 'sender' as sender, event #>> '{account,login}' as login
         from app.webhook_deliveries where delivery_id = $1`,
      [pending.deliveryId],
    );
    expect(rows).toEqual([{ sender: { id: 77, login: "installer" }, login: "moving" }]);
    expect(await orgOf(9131)).toMatchObject({ id: fresh.id, installer_forge_user_id: "5" });
  });

  it("SF2: transient failures do not use up the contradiction window", async () => {
    // A created that GitHub answers 404 for, after two outages.
    const { deliveryId } = await install(9140, 19140, "late-api");
    for (let i = 0; i < 2; i++) {
      github.failNext(503);
      await drain();
      await makeRetriesDue();
    }
    expect(await inboxRow(deliveryId)).toMatchObject({ attempts: 2, strikes: 0 });
    await drain();
    // The first contradiction, on attempt 3: retried, not believed.
    expect(await inboxRow(deliveryId)).toMatchObject({
      processed: false,
      attempts: 3,
      strikes: 1,
      last_error: "forge_contradiction",
    });
    github.install(9140, { id: 19140, login: "late-api", type: "Organization" });
    await makeRetriesDue();
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "org_created", attempts: 4 });
  });

  it("N-b: the sweep erases only orgs of its own forge", async () => {
    const gitlabOrg = newOrgId();
    await workerDb.withOrg(gitlabOrg, (tx) =>
      insertInstallationOrg(tx, {
        forge: "gitlab",
        installationId: 9150,
        accountId: 19150,
        login: "elsewhere",
        kind: "organization",
        installerForgeUserId: null,
      }),
    );
    await superuser.query("alter table orgs disable trigger user");
    try {
      await superuser.query(
        "update orgs set delete_after = now() - interval '1 day' where id = $1",
        [gitlabOrg],
      );
    } finally {
      await superuser.query("alter table orgs enable trigger user");
    }
    const asked = github.requests.length;
    expect(await sweep()).toMatchObject({ due: 0, deleted: 0, cancelled: 0 });
    expect(github.requests.slice(asked).filter((r) => r.path !== "/app")).toEqual([]);
    const { rows } = await superuser.query("select 1 from orgs where id = $1", [gitlabOrg]);
    expect(rows).toHaveLength(1);
    // delete_org needs the sweep's mark (review round 4); this clean-up stands in for a gitlab sweep.
    expect(await workerDb.withOrg(gitlabOrg, (tx) => beginOrgErasure(tx))).toBe("started");
    await workerDb.deleteOrg(gitlabOrg);
  });
});

describe("review round 3", () => {
  it("N planted created rows ahead of a genuine uninstall cost O(1) GitHub decisions, not N", async () => {
    github.install(9160, { id: 19160, login: "flooded", type: "Organization" });
    await install(9160, 19160, "flooded");
    await drain();
    github.uninstall(9160);
    const N = 40;
    const app = new pg.Pool({ connectionString: pgs.appUrl, max: 1 }).on("error", ignoreIdleError);
    try {
      // Decodable (the shape CHECK holds), older than the genuine uninstall.
      await app.query(
        `insert into app.webhook_deliveries
           (forge, delivery_id, payload_sha256, event_type, installation_id, event)
         select 'github', gen_random_uuid()::text, sha256(convert_to('planted-9160-' || i, 'utf8')),
                'installation.created', 9160,
                jsonb_build_object('type', 'installation.created', 'installationId', 9160,
                  'account', jsonb_build_object('id', 19160, 'login', 'flooded', 'kind', 'organization'),
                  'sender', jsonb_build_object('id', 666, 'login', 'attacker'))
           from generate_series(1, $1::int) i`,
        [N],
      );
    } finally {
      await app.end();
    }
    await superuser.query(
      "update app.webhook_deliveries set received_at = received_at - interval '1 minute' where installation_id = 9160 and processed_at is null",
    );
    const { deliveryId } = await uninstall(9160, 19160, "flooded");
    const asked = github.requests.length;
    for (let round = 0; round < 8; round++) {
      await drain();
      await makeRetriesDue();
      if ((await inboxRow(deliveryId))?.processed) break;
    }
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "deletion_scheduled" });
    const reads = github.requests.slice(asked).filter((r) => r.path === "/app/installations/9160");
    // One created row decides for all of them (three contradictions, then believed), then the
    // uninstall: a handful of reads, independent of N.
    expect(reads.length).toBeLessThanOrEqual(CONTRADICTION_ATTEMPTS + 2);
    const { rows } = await superuser.query<{ outcome: string; n: number }>(
      `select outcome, count(*)::int as n from app.webhook_deliveries
        where installation_id = 9160 and event_type = 'installation.created' and outcome <> 'org_created'
        group by 1 order by 1`,
    );
    expect(rows).toEqual([
      { outcome: "installation_not_found", n: 1 },
      { outcome: "superseded", n: N - 1 },
    ]);
  });
});

describe("review round 5", () => {
  it("N2: delete_org refusing an org that is not erasing (55000) is a failure, logged and counted, not a skip", async () => {
    github.install(9170, { id: 19170, login: "unmarked", type: "Organization" });
    await install(9170, 19170, "unmarked");
    await drain();
    github.uninstall(9170);
    await uninstall(9170, 19170, "unmarked");
    await drain();
    const org = await orgOf(9170);
    await advanceGrace(org!.id, 8);
    // A listing that wrongly claims the org is already erasing: the sweep skips the re-check
    // and the mark, and the database refuses the erasure.
    const lying: Db = {
      ...workerDb,
      orgsDueForDeletion: async (limit) =>
        (await workerDb.orgsDueForDeletion(limit)).map((o) =>
          o.orgId === org!.id ? { ...o, erasing: true } : o,
        ),
    };
    const before = logLines.length;
    const report = await sweep(lying);
    expect(report).toMatchObject({ failed: 1, skipped: 0, deleted: 0 });
    expect(await orgOf(9170)).toBeDefined();
    const failure = logLines
      .slice(before)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l["msg"] === "org erasure failed; retried next sweep");
    expect(failure).toMatchObject({ orgId: org!.id, errorCode: "55000" });
    // The honest sweep then re-verifies, marks and erases it.
    expect(await sweep()).toMatchObject({ deleted: 1, failed: 0 });
    expect(await orgOf(9170)).toBeUndefined();
  });
});

describe("logs", () => {
  it("never contain the key, the app JWT, logins, emails or event content", () => {
    const all = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(10);
    expect(all).not.toContain("PRIVATE KEY");
    expect(all).not.toContain(keys.privateKeyPem.split("\n")[1]!);
    expect(all).not.toMatch(/Bearer|eyJ[A-Za-z0-9_-]{10,}/);
    for (const text of ["acme", "comeback", "alice", "attacker", PLANTED.email]) {
      expect(all, text).not.toContain(text);
    }
  });
});
