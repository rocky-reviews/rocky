import { createHash, randomBytes } from "node:crypto";
import { createDb, loadForgeToken, storeForgeToken, type Db } from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import { createGitHubWebhookIngress } from "@rocky-reviews/forge-github";
import {
  organizationPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import { buildApp } from "@rocky-reviews/server/app";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainOrgMemberEvents } from "./inbox.js";

/**
 * P7-2 end to end (ADR 0024 §6): a signed `organization` webhook (`member_removed`) into
 * `POST /webhooks/github` (server login) → the inbox → the worker's org member lane (worker
 * login) → inside the org's `withOrg`: the person's stored token is deleted and the org is cut
 * from their live sessions. Nothing is granted from a webhook, and an event naming another
 * account than the org's binding is parked.
 */

const ALICE = 1001; // seedOrg's member in every org
const sha = (value: string) => createHash("sha256").update(value).digest();
const CIPHERTEXT = `rk1:${Buffer.concat([Buffer.from([0, 0, 0, 1]), randomBytes(40)]).toString("base64url")}`;

let pgs: TestPostgres;
let superuser: pg.Pool;
let serverDb: Db;
let workerDb: Db;
let app: ReturnType<typeof buildApp>;
let A: SeededOrg;
let B: SeededOrg;
const lines: string[] = [];
const log = createLogger("org-members-e2e", {
  level: "debug",
  destination: { write: (line: string) => void lines.push(line) },
});

const INSTALLATION_A = 8101;
const ACCOUNT_A = 1_000_000 + INSTALLATION_A;
const INSTALLATION_B = 8102;

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  serverDb = createDb({ connectionString: pgs.appUrl, max: 4 });
  workerDb = createDb({ connectionString: pgs.workerUrl, max: 4 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: INSTALLATION_A }),
    await seedOrg(w, newOrgId(), { installationId: INSTALLATION_B }),
  ]);
  app = buildApp({
    checkDatabase: () => Promise.resolve(true),
    webhooks: {
      ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }),
      inbox: { record: (d) => serverDb.recordWebhookDelivery(d) },
    },
  });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await serverDb?.close();
  await workerDb?.close();
  await superuser?.end();
  await pgs?.stop();
});

const post = async (payload: unknown, event = "organization") => {
  const d = signedDelivery(event, payload);
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: d.headers,
    payload: d.body,
  });
  return { status: res.statusCode, deliveryId: d.headers["x-github-delivery"]!, d };
};

const drain = () =>
  drainOrgMemberEvents({
    db: workerDb,
    forge: { kind: "github" },
    appCheck: { ready: () => Promise.resolve(true) },
    log,
    batchSize: 10,
  });

const inboxRow = async (deliveryId: string) =>
  (
    await superuser.query<{ outcome: string | null; parked: boolean; last_error: string | null }>(
      `select outcome, parked_at is not null as parked, last_error
         from app.webhook_deliveries where delivery_id = $1`,
      [deliveryId],
    )
  ).rows[0];

const liveSession = async (org: SeededOrg) => {
  const now = new Date();
  const { userId } = await serverDb.sessions.upsertUser("github", ALICE, now);
  const token = randomBytes(32).toString("base64url");
  await serverDb.sessions.createSession({
    tokenSha256: sha(token),
    userId,
    orgs: [{ orgId: org.orgId, memberId: org.memberId }],
    activeOrgId: org.orgId,
    now,
    idleTimeoutSeconds: 3600,
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return token;
};

const links = async (org: SeededOrg) =>
  (
    await superuser.query("select 1 from app.session_orgs where org_id = $1 and member_id = $2", [
      org.orgId,
      org.memberId,
    ])
  ).rowCount;

describe("leaving the GitHub organization (organization webhook, member_removed)", () => {
  it("deletes the stored token and cuts the org from live sessions, in that org only", async () => {
    for (const org of [A, B]) {
      await serverDb.withOrg(org.orgId, (tx) => storeForgeToken(tx, org.memberId, CIPHERTEXT, 1));
      await liveSession(org);
    }
    const token = await liveSession(A);
    const { status, deliveryId } = await post(
      organizationPayload("member_removed", {
        installationId: INSTALLATION_A,
        organizationId: ACCOUNT_A,
        login: `org-${INSTALLATION_A}`,
        memberId: ALICE,
      }),
    );
    expect(status).toBe(202);
    expect(await drain()).toMatchObject({ claimed: 1, processed: 1 });
    expect(await inboxRow(deliveryId)).toEqual({
      outcome: "member_left",
      parked: false,
      last_error: null,
    });
    expect(await serverDb.withOrg(A.orgId, (tx) => loadForgeToken(tx, A.memberId))).toBeNull();
    expect(await links(A)).toBe(0);
    const session = await serverDb.sessions.findSession(sha(token), new Date());
    expect(session?.orgs).toEqual([]);
    expect(session?.activeOrgId).toBeNull();
    // The same person in org B keeps everything.
    expect(await serverDb.withOrg(B.orgId, (tx) => loadForgeToken(tx, B.memberId))).not.toBeNull();
    expect(await links(B)).toBeGreaterThan(0);
    // The member row and its role stay; the event is audited with the forge as the actor.
    const audit = await superuser.query(
      "select actor_type, actor_id from audit_events where org_id = $1 and action = 'member.left_forge'",
      [A.orgId],
    );
    expect(audit.rows).toEqual([{ actor_type: "forge", actor_id: deliveryId }]);
    const row = await superuser.query("select role, removed_at from members where id = $1", [
      A.memberId,
    ]);
    expect(row.rows).toEqual([{ role: "admin", removed_at: null }]);
    // Logs carry ids and codes only.
    const joined = lines.join("\n");
    expect(joined).not.toContain("octo-dev");
    expect(joined).not.toContain(CIPHERTEXT);
  });

  it("a replayed delivery is a duplicate and changes nothing more", async () => {
    const payload = organizationPayload("member_removed", {
      installationId: INSTALLATION_A,
      organizationId: ACCOUNT_A,
      login: `org-${INSTALLATION_A}`,
      memberId: 4444,
    });
    const first = await post(payload);
    const replay = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: first.d.headers,
      payload: first.d.body,
    });
    expect(replay.statusCode).toBe(200);
    expect(await drain()).toMatchObject({ claimed: 1, processed: 1 });
    expect((await inboxRow(first.deliveryId))?.outcome).toBe("no_member");
  });

  it("parks an event whose organization is not the account the installation's org is bound to", async () => {
    await serverDb.withOrg(B.orgId, (tx) => storeForgeToken(tx, B.memberId, CIPHERTEXT, 1));
    const { deliveryId } = await post(
      organizationPayload("member_removed", {
        installationId: INSTALLATION_B,
        organizationId: ACCOUNT_A, // A's account through B's installation
        login: "spoofed",
        memberId: ALICE,
      }),
    );
    expect(await drain()).toMatchObject({ claimed: 1, parked: 1 });
    expect(await inboxRow(deliveryId)).toMatchObject({
      parked: true,
      last_error: "account_mismatch",
    });
    expect(await serverDb.withOrg(B.orgId, (tx) => loadForgeToken(tx, B.memberId))).not.toBeNull();
  });

  it("finishes an event for an installation without an org as no_org", async () => {
    const { deliveryId } = await post(
      organizationPayload("member_removed", { installationId: 8199, organizationId: 77_777 }),
    );
    await drain();
    expect((await inboxRow(deliveryId))?.outcome).toBe("no_org");
  });

  it("stores nothing for joins, invitations or team membership changes: nothing is granted from a webhook", async () => {
    const before = await superuser.query("select count(*)::int as n from app.webhook_deliveries");
    for (const action of ["member_added", "member_invited", "renamed"]) {
      expect((await post(organizationPayload(action))).status).toBe(200);
    }
    expect(
      (await post({ ...organizationPayload("removed"), scope: "team" }, "membership")).status,
    ).toBe(200);
    const after = await superuser.query("select count(*)::int as n from app.webhook_deliveries");
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("refuses an unsigned organization webhook", async () => {
    const d = signedDelivery("organization", organizationPayload("member_removed"));
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: { ...d.headers, "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
      payload: d.body,
    });
    expect(res.statusCode).toBe(401);
  });
});
