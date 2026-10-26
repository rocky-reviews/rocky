import { randomUUID } from "node:crypto";
import {
  nothingStoredYet,
  type ExternalTenantStore,
  type OrgErasers,
  type OrgId,
} from "@rocky-reviews/core";
import { createDb, schema, WEBHOOK_MAX_ATTEMPTS, type Db } from "@rocky-reviews/db";
import {
  CONTAINER_TIMEOUT_MS,
  seedOrg,
  startPostgres,
  type TestPostgres,
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
import { sweepOrgDeletions } from "./deletion-sweep.js";
import { drainInstallationEvents } from "./inbox.js";

/**
 * P3-3 end to end: a signed webhook into `POST /webhooks/github` → the inbox (server login) →
 * the worker claims it (worker login) → GitHub re-verification (the recorded, sanitised fixtures
 * in packages/forge-github/fixtures, served by a fake that checks the app JWT) → org created,
 * deletion scheduled, cancelled, executed. Real Postgres, real roles, real RLS.
 */

const DAY = 86_400_000;

let pgs: TestPostgres;
let superuser: pg.Pool;
let serverDb: Db;
let workerDb: Db;
let app: ReturnType<typeof buildApp>;
let github: FakeGitHubApi;
let reader: ReturnType<typeof createGitHubInstallationReader>;
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
const drain = (db: Db = workerDb) =>
  drainInstallationEvents({ db, forge: reader, log, newOrgId, batchSize: 10 });
const sweep = () => sweepOrgDeletions({ db: workerDb, erasers, log });

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
      last_error: string | null;
    }>(
      `select outcome, processed_at is not null as processed, parked_at is not null as parked,
              attempts, last_error
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

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 });
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
    await seedOrg(workerDb, org!.id as OrgId, { orgExists: true });
    const control = await seedOrg(workerDb, newOrgId(), { installationId: 5999 });
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
    expect(await sweep()).toEqual({ due: 1, deleted: 1, skipped: 0, failed: 0 });
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
    expect(await sweep()).toEqual({ due: 0, deleted: 0, skipped: 0, failed: 0 });
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
    expect(await sweepOrgDeletions({ db: workerDb, erasers: failing, log })).toMatchObject({
      failed: 1,
      deleted: 0,
    });
    expect(await orgOf(5100)).toBeDefined();
    fail = false;
    expect(await sweepOrgDeletions({ db: workerDb, erasers: failing, log })).toMatchObject({
      deleted: 1,
    });
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
      const reports = await Promise.all([sweep(), sweepOrgDeletions({ db: other, erasers, log })]);
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
    expect(await workerDb.orgsDueForDeletion(100)).not.toContain(org!.id);
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
    await drain();
    expect(await inboxRow(planted.deliveryId)).toMatchObject({
      outcome: "installation_not_found",
      processed: true,
    });
    expect(await orgOf(7001)).toBeUndefined();
    expect(await workerDb.installationOrgs("github", 7001, 9700)).toEqual([]);
  });

  it("an installation.deleted while GitHub still has the installation (active or suspended) deletes nothing", async () => {
    github.install(7100, { id: 9710, login: "stays", type: "Organization" });
    await install(7100, 9710, "stays");
    await drain();
    const { deliveryId } = await uninstall(7100, 9710, "stays");
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "installation_exists" });
    expect((await orgOf(7100))?.delete_after).toBeNull();

    // Suspended is not deleted.
    github.install(7100, { id: 9710, login: "stays", type: "Organization" }, { suspended: true });
    const suspended = await post("installation", {
      ...installationPayload("deleted", { installationId: 7100, accountId: 9710, login: "stays" }),
      sender: { id: 8, login: "suspender" },
    });
    await drain();
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

    // A worker with a key GitHub does not accept gets 401 every time: still nothing deleted.
    const wrongKey = testAppKeys();
    const badReader = createGitHubInstallationReader({
      auth: parseGitHubAppAuth({
        appId: String(FIXTURE_APP_ID),
        privateKey: wrongKey.privateKeyPem,
      }),
      api: githubEndpoints({}).api,
      clock: { now: () => new Date() },
      fetch: github.fetch,
    });
    await makeRetriesDue();
    await drainInstallationEvents({ db: workerDb, forge: badReader, log, newOrgId });
    expect(await inboxRow(deliveryId)).toMatchObject({
      last_error: "forge_http_401",
      processed: false,
    });
    expect((await orgOf(7200))?.delete_after).toBeNull();

    // Once GitHub answers, the uninstall goes through.
    await makeRetriesDue();
    await drain();
    expect(await inboxRow(deliveryId)).toMatchObject({
      outcome: "deletion_scheduled",
      attempts: 3,
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
    expect(rows).toEqual([
      { outcome: "already_installed", n: 4 },
      { outcome: "org_created", n: 12 },
    ]);
  });

  it("a worker that crashes mid-processing loses nothing: the lease expires and the row is retried", async () => {
    github.install(8100, { id: 9810, login: "crash", type: "Organization" });
    const { deliveryId } = await install(8100, 9810, "crash");
    // A worker claims the row and dies before finishing.
    const [claimed] = await workerDb.claimWebhookDeliveries({
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

  it("parks poison rows: bounded attempts on repeated failures, at once when a row cannot succeed", async () => {
    // GitHub fails for this installation every time.
    github.install(8200, { id: 9820, login: "poison", type: "Organization" });
    const poison = await install(8200, 9820, "poison");
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS + 2; i++) {
      // Fail every attempt; once parked, further drains must not even ask GitHub.
      if ((await inboxRow(poison.deliveryId))?.parked !== true) github.failNext(500);
      await makeRetriesDue();
      await drain();
    }
    expect(await inboxRow(poison.deliveryId)).toMatchObject({
      parked: true,
      processed: false,
      attempts: WEBHOOK_MAX_ATTEMPTS,
      last_error: "forge_http_500",
    });
    expect(await orgOf(8200)).toBeUndefined();

    // A stored row that no longer decodes (tampered in place) is parked on the first claim.
    const tampered = await install(8201, 9821, "tampered");
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
