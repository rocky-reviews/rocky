import { createHash, randomUUID } from "node:crypto";
import type { Forge, OrgId } from "@rocky-reviews/core";
import { createDb, type Db } from "@rocky-reviews/db";
import {
  CONTAINER_TIMEOUT_MS,
  startPostgres,
  type TestPostgres,
  ignoreIdleError,
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
  PLANTED,
  pullRequestPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
  testAppKeys,
  type FakeGitHubApi,
  type FakePullRequest,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import { buildApp } from "@rocky-reviews/server/app";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppCheck, type AppCheck } from "./app-check.js";
import { drainInstallationEvents, drainPullRequestEvents } from "./inbox.js";
import { CONTRADICTION_ATTEMPTS } from "./installations.js";
import { RebuildError, rebuildRepositoryMirror } from "./mirror-rebuild.js";
import { MIRROR_DIFF_MAX_BYTES } from "./pull-requests.js";

/**
 * P3-4 end to end (ADR 0010): signed `pull_request` webhooks into `POST /webhooks/github` → the
 * inbox (server login) → the worker's pull request lane (worker login) → GitHub re-read on a
 * repository-scoped, read-only installation token (fixtures in the shape GitHub documents, with
 * synthetic ids, in packages/forge-github/fixtures, served by `fakeGitHubApi`; not recorded from
 * GitHub) → the mirror (`repos`, `pull_requests`, `pr_revisions`, under RLS). Then the acceptance
 * criterion: the rebuild-from-GitHub command recreates the mirror state of a repository.
 */

const HEAD_1 = "1".repeat(40);
const HEAD_1B = "2".repeat(40);
const HEAD_2 = "3".repeat(40);
const HEAD_3 = "4".repeat(40);
const HEAD_4 = "5".repeat(40);
const HEAD_5 = "6".repeat(40);
const BASE = "b".repeat(40);
/** Something only a diff contains: must never reach a log or the database. */
const DIFF_MARKER = "+const leakedOnlyInDiffs = 'diff-content-marker';\n";

let pgs: TestPostgres;
let superuser: pg.Pool;
let serverDb: Db;
let workerDb: Db;
let app: ReturnType<typeof buildApp>;
let github: FakeGitHubApi;
let forge: Forge;
let appCheck: AppCheck;
const keys = testAppKeys();
const logLines: string[] = [];
const log = createLogger("mirror-e2e", {
  level: "debug",
  destination: { write: (line: string) => void logLines.push(line) },
});
let nextInstallation = 7000;
let nextRepository = 700;
let clockMinute = 0;
/** A GitHub `updated_at` that moves forward with every change the test makes. */
const tick = (): string => new Date(Date.UTC(2026, 9, 26, 10, ++clockMinute)).toISOString();

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

const drainInstallations = () =>
  drainInstallationEvents({
    db: workerDb,
    forge,
    appCheck,
    log,
    newOrgId: () => randomUUID() as OrgId,
    batchSize: 10,
  });
const drainPullRequests = () =>
  drainPullRequestEvents({ db: workerDb, forge, appCheck, log, batchSize: 5 });

const makeRetriesDue = () =>
  superuser.query(
    "update app.webhook_deliveries set available_at = now() where processed_at is null and parked_at is null",
  );

const inboxRow = async (deliveryId: string) =>
  (
    await superuser.query<{
      outcome: string | null;
      processed: boolean;
      parked: boolean;
      strikes: number;
      last_error: string | null;
    }>(
      `select outcome, processed_at is not null as processed, parked_at is not null as parked,
              strikes, last_error
         from app.webhook_deliveries where delivery_id = $1`,
      [deliveryId],
    )
  ).rows[0];

/** A tenant with one repository on GitHub, installed through the lifecycle (P3-3). */
const tenant = async () => {
  const installationId = nextInstallation++;
  const accountId = installationId + 100_000;
  const repositoryId = nextRepository++;
  const login = `acct-${installationId}`;
  const fullName = `${login}/api`;
  github.install(installationId, { id: accountId, login, type: "Organization" });
  github.addRepository(installationId, { id: repositoryId, fullName });
  expect(
    (
      await post(
        "installation",
        installationPayload("created", { installationId, accountId, login }),
      )
    ).status,
  ).toBe(202);
  await drainInstallations();
  const { rows } = await superuser.query<{ id: OrgId }>(
    "select id from orgs where installation_id = $1",
    [installationId],
  );
  expect(rows).toHaveLength(1);
  return { installationId, repositoryId, fullName, orgId: rows[0]!.id };
};

type Tenant = Awaited<ReturnType<typeof tenant>>;

/** GitHub changes a pull request (and its `updated_at`), then sends the webhook. */
const change = async (
  t: Tenant,
  action: "opened" | "synchronize" | "closed" | "reopened",
  pr: FakePullRequest,
) => {
  github.putPullRequest(t.repositoryId, { ...pr, updatedAt: tick() });
  return post(
    "pull_request",
    pullRequestPayload(action, {
      installationId: t.installationId,
      repositoryId: t.repositoryId,
      number: pr.number,
      headSha: pr.headSha,
      merged: pr.merged ?? false,
    }),
  );
};

/** Drains the pull request lane until nothing is claimable (retries made due in between). */
const drainAll = async () => {
  for (let i = 0; i < 20; i++) {
    const report = await drainPullRequests();
    if (report.claimed === 0) return;
    await makeRetriesDue();
  }
  throw new Error("pull request lane did not settle");
};

/**
 * The mirror state of one repository, without row ids or local timestamps: what GitHub
 * determines. Head revisions only (see ADR 0010 §4); `allRevisions` lists every one.
 */
const mirrorState = async (orgId: OrgId, repositoryId: number) => {
  const repos = await superuser.query(
    `select forge_repo_id::int, full_name, private, default_branch, enabled
       from repos where org_id = $1 and forge_repo_id = $2`,
    [orgId, repositoryId],
  );
  const prs = await superuser.query(
    `select p.number, p.title, p.author_login, p.state, p.head_sha, p.base_sha, p.opened_at,
            p.closed_at, p.forge_updated_at,
            r.base_sha as revision_base, r.stats, r.diff_bytes, encode(r.diff_sha256, 'hex') as diff_sha256,
            r.diff_truncated, r.diff_truncation
       from pull_requests p
       join repos rp on rp.org_id = p.org_id and rp.id = p.repo_id
       left join pr_revisions r
         on r.org_id = p.org_id and r.pull_request_id = p.id and r.head_sha = p.head_sha
      where p.org_id = $1 and rp.forge_repo_id = $2
      order by p.number`,
    [orgId, repositoryId],
  );
  return { repos: repos.rows, pullRequests: prs.rows };
};

const allRevisions = async (orgId: OrgId) =>
  (
    await superuser.query<{ number: number; head_sha: string }>(
      `select p.number, r.head_sha from pr_revisions r
         join pull_requests p on p.org_id = r.org_id and p.id = r.pull_request_id
        where r.org_id = $1 order by p.number, r.created_at`,
      [orgId],
    )
  ).rows;

const compareReads = () => github.requests.filter((r) => r.path.includes("/compare/")).length;

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
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await serverDb?.close();
  await workerDb?.close();
  await superuser?.end();
  await pgs?.stop();
});

describe("acceptance: the rebuild-from-GitHub command recreates the mirror state for a repo", () => {
  it("webhooks build the mirror; after it is lost, the rebuild recreates exactly that state", async () => {
    const t = await tenant();
    // #1 opened, then pushed to; #2 merged; #3 closed and reopened; #4 a diff GitHub will not
    // render; #5 a diff longer than the mirror reads.
    github.putDiff(t.repositoryId, { baseSha: BASE, headSha: HEAD_1 }, `${DIFF_MARKER}+a\n`);
    github.putDiff(t.repositoryId, { baseSha: BASE, headSha: HEAD_4 }, "too_large");
    github.putDiff(
      t.repositoryId,
      { baseSha: BASE, headSha: HEAD_5 },
      `+${"x".repeat(99)}\n`.repeat(Math.ceil(MIRROR_DIFF_MAX_BYTES / 100) + 10),
    );
    await change(t, "opened", { number: 1, headSha: HEAD_1, baseSha: BASE, title: PLANTED.title });
    // Processed before the push arrives, so the first head gets its own revision.
    await drainAll();
    await change(t, "synchronize", {
      number: 1,
      headSha: HEAD_1B,
      baseSha: BASE,
      title: PLANTED.title,
      additions: 9,
    });
    await change(t, "opened", { number: 2, headSha: HEAD_2, baseSha: BASE });
    await change(t, "closed", { number: 2, headSha: HEAD_2, baseSha: BASE, merged: true });
    await change(t, "opened", { number: 3, headSha: HEAD_3, baseSha: BASE, authorLogin: null });
    await change(t, "closed", { number: 3, headSha: HEAD_3, baseSha: BASE, state: "closed" });
    await change(t, "reopened", { number: 3, headSha: HEAD_3, baseSha: BASE, authorLogin: null });
    await change(t, "opened", { number: 4, headSha: HEAD_4, baseSha: BASE });
    await change(t, "opened", { number: 5, headSha: HEAD_5, baseSha: BASE });
    await drainAll();

    const built = await mirrorState(t.orgId, t.repositoryId);
    expect(built.repos).toEqual([
      {
        forge_repo_id: t.repositoryId,
        full_name: t.fullName,
        private: true,
        default_branch: "main",
        enabled: true,
      },
    ]);
    expect(
      built.pullRequests.map((p) => [p.number, p.state, p.head_sha, p.diff_truncation]),
    ).toEqual([
      [1, "open", HEAD_1B, null],
      [2, "merged", HEAD_2, null],
      [3, "open", HEAD_3, null],
      [4, "open", HEAD_4, "forge_limit"],
      [5, "open", HEAD_5, "max_bytes"],
    ]);
    expect(built.pullRequests[0]).toMatchObject({ title: PLANTED.title, stats: { additions: 9 } });
    expect(built.pullRequests[2]).toMatchObject({ author_login: null });
    expect(built.pullRequests[4]!.diff_bytes).toBeLessThanOrEqual(MIRROR_DIFF_MAX_BYTES);
    expect(built.pullRequests.every((p) => p.diff_sha256 !== null)).toBe(true);
    // #1 has two revisions: one per head seen.
    expect((await allRevisions(t.orgId)).filter((r) => r.number === 1)).toHaveLength(2);

    // The mirror is lost (a restore without it, a bug): the repository row and everything under it.
    await superuser.query("delete from repos where org_id = $1 and forge_repo_id = $2", [
      t.orgId,
      t.repositoryId,
    ]);
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests).toEqual([]);

    const report = await rebuildRepositoryMirror({ db: workerDb, forge }, t.fullName);
    expect(report).toEqual({
      orgId: t.orgId,
      installationId: t.installationId,
      repositoryId: t.repositoryId,
      listed: 5,
      mirrored: 5,
      unchanged: 0,
      missing: 0,
      stale: 0,
      revisionsRecorded: 5,
      truncatedDiffs: 2,
      notListed: 0,
      limitReached: false,
    });
    expect(await mirrorState(t.orgId, t.repositoryId)).toEqual(built);
    // Earlier heads cannot be recreated (GitHub keeps no list of them): only the current one.
    expect((await allRevisions(t.orgId)).filter((r) => r.number === 1)).toEqual([
      { number: 1, head_sha: HEAD_1B },
    ]);

    // Again: nothing changes and nothing is read but the listing (no pull request, no diff).
    const before = github.requests.length;
    const again = await rebuildRepositoryMirror({ db: workerDb, forge }, t.fullName);
    expect(again).toMatchObject({ listed: 5, unchanged: 5, mirrored: 0, revisionsRecorded: 0 });
    expect(await mirrorState(t.orgId, t.repositoryId)).toEqual(built);
    const reads = github.requests.slice(before).map((r) => r.path);
    expect(reads.some((p) => /\/pulls\/\d+$/.test(p) || p.includes("/compare/"))).toBe(false);
    // Every token the rebuilds minted was revoked.
    expect(github.tokens.revoked).toBe(github.tokens.issued.length);
  });

  it("repairs drift and brings in pull requests no webhook told it about; keeps rows GitHub no longer lists", async () => {
    const t = await tenant();
    await change(t, "opened", { number: 10, headSha: HEAD_1, baseSha: BASE });
    await drainAll();
    // Missed webhooks (server down): #11 exists only on GitHub; #10 was pushed to and closed.
    github.putPullRequest(t.repositoryId, { number: 11, headSha: HEAD_2, updatedAt: tick() });
    github.putPullRequest(t.repositoryId, {
      number: 10,
      headSha: HEAD_1B,
      baseSha: BASE,
      state: "closed",
      updatedAt: tick(),
    });
    // Drift in the mirror: a tampered title, a row GitHub does not have.
    await superuser.query(
      "update pull_requests set title = 'tampered', forge_updated_at = null where org_id = $1 and number = 10",
      [t.orgId],
    );
    const repo = await superuser.query<{ id: string }>(
      "select id from repos where org_id = $1 and forge_repo_id = $2",
      [t.orgId, t.repositoryId],
    );
    await superuser.query(
      `insert into pull_requests (org_id, repo_id, number, title, state, head_sha, base_sha, opened_at)
       values ($1, $2, 99, 'kept', 'open', $3, $4, now())`,
      [t.orgId, repo.rows[0]!.id, HEAD_3, BASE],
    );

    const report = await rebuildRepositoryMirror({ db: workerDb, forge }, t.fullName);
    expect(report).toMatchObject({ listed: 2, mirrored: 2, notListed: 1, limitReached: false });
    const state = await mirrorState(t.orgId, t.repositoryId);
    expect(state.pullRequests.map((p) => [p.number, p.state, p.head_sha, p.title])).toEqual([
      [10, "closed", HEAD_1B, "Add invite flow"],
      [11, "open", HEAD_2, "Add invite flow"],
      [99, "open", HEAD_3, "kept"],
    ]);
    // #10's earlier revision is kept; the new head got its own.
    expect((await allRevisions(t.orgId)).filter((r) => r.number === 10)).toEqual([
      { number: 10, head_sha: HEAD_1 },
      { number: 10, head_sha: HEAD_1B },
    ]);
  });

  it("honours the limit (newest first) and then does not claim to know what GitHub did not list", async () => {
    const t = await tenant();
    for (const n of [1, 2, 3]) {
      github.putPullRequest(t.repositoryId, {
        number: n,
        headSha: HEAD_1,
        createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
      });
    }
    const report = await rebuildRepositoryMirror({ db: workerDb, forge }, t.fullName, { limit: 2 });
    expect(report).toMatchObject({ listed: 2, mirrored: 2, limitReached: true, notListed: null });
    const state = await mirrorState(t.orgId, t.repositoryId);
    expect(state.pullRequests.map((p) => p.number)).toEqual([2, 3]);
  });

  it("refuses to rebuild what it cannot verify, and touches no tenant then", async () => {
    await expect(
      rebuildRepositoryMirror({ db: workerDb, forge }, "nobody/nothing"),
    ).rejects.toMatchObject({ code: "app_not_installed" });
    // Installed on GitHub, but the lifecycle never created the org.
    const installationId = nextInstallation++;
    github.install(installationId, {
      id: 1_000_000 + installationId,
      login: "orphan",
      type: "Organization",
    });
    github.addRepository(installationId, { id: nextRepository++, fullName: "orphan/api" });
    await expect(rebuildRepositoryMirror({ db: workerDb, forge }, "orphan/api")).rejects.toEqual(
      new RebuildError("no_org"),
    );
    const suspended = await tenant();
    github.install(
      suspended.installationId,
      {
        id: suspended.installationId + 100_000,
        login: `acct-${suspended.installationId}`,
        type: "Organization",
      },
      { suspended: true },
    );
    await expect(
      rebuildRepositoryMirror({ db: workerDb, forge }, suspended.fullName),
    ).rejects.toMatchObject({ code: "installation_suspended" });
    await expect(rebuildRepositoryMirror({ db: workerDb, forge }, "../x")).rejects.toThrow(
      /owner\/name/,
    );
    await expect(
      rebuildRepositoryMirror({ db: workerDb, forge }, suspended.fullName, { limit: 0 }),
    ).rejects.toThrow(/limit/);
    // A key for another app reads nothing.
    github.reportAppId(FIXTURE_APP_ID + 1);
    await expect(
      rebuildRepositoryMirror({ db: workerDb, forge }, suspended.fullName),
    ).rejects.toMatchObject({ code: "forge_app_mismatch" });
    github.reportAppId(FIXTURE_APP_ID);
  });
});

describe("pull request events: GitHub's answer, not the event, is what is mirrored", () => {
  it("re-reads the pull request on a scoped, read-only token that is revoked after the row", async () => {
    const t = await tenant();
    const mintsBefore = github.tokens.mints.length;
    const { deliveryId } = await change(t, "opened", { number: 5, headSha: HEAD_1, baseSha: BASE });
    await drainAll();
    expect(await inboxRow(deliveryId)).toMatchObject({ processed: true, outcome: "pr_mirrored" });
    expect(github.tokens.mints.slice(mintsBefore)).toEqual([
      {
        installationId: t.installationId,
        body: {
          repository_ids: [t.repositoryId],
          permissions: { contents: "read", pull_requests: "read" },
        },
      },
    ]);
    expect(github.tokens.revoked).toBe(github.tokens.issued.length);
  });

  it("a stale or replayed event changes nothing: the mirror follows GitHub's current state", async () => {
    const t = await tenant();
    await change(t, "opened", { number: 6, headSha: HEAD_1, baseSha: BASE });
    await change(t, "synchronize", { number: 6, headSha: HEAD_1B, baseSha: BASE });
    await drainAll();
    const state = await mirrorState(t.orgId, t.repositoryId);
    const diffs = compareReads();
    // A late copy of the first event (its head is long gone), replayed after the dedup window or
    // planted: a new inbox row.
    const late = { deliveryId: randomUUID() };
    await serverDb.recordWebhookDelivery({
      forge: "github",
      deliveryId: late.deliveryId,
      payloadSha256: randomUUID().replaceAll("-", "").repeat(2),
      event: {
        type: "pull_request.opened",
        installationId: t.installationId,
        repositoryId: t.repositoryId,
        number: 6,
        headSha: HEAD_1,
        merged: false,
      },
    });
    await drainAll();
    // Its head disagrees with GitHub's: retried as a lagging read (review round 1), then GitHub's
    // answer is believed and the mirror is unchanged.
    expect(await inboxRow(late.deliveryId)).toMatchObject({
      processed: true,
      outcome: "pr_unchanged",
      strikes: CONTRADICTION_ATTEMPTS - 1,
      last_error: "forge_head_mismatch",
    });
    expect(await mirrorState(t.orgId, t.repositoryId)).toEqual(state);
    // The head's diff was read once, not again for the replay.
    expect(compareReads()).toBe(diffs);
  });

  it("review round 1: a lagging read of a push is retried, and the next read records the new head", async () => {
    const t = await tenant();
    await change(t, "opened", { number: 12, headSha: HEAD_1, baseSha: BASE });
    await drainAll();
    // GitHub sends the push, but its API still answers with the old head for a moment.
    const push = await post(
      "pull_request",
      pullRequestPayload("synchronize", {
        installationId: t.installationId,
        repositoryId: t.repositoryId,
        number: 12,
        headSha: HEAD_1B,
      }),
    );
    await drainPullRequests();
    expect(await inboxRow(push.deliveryId)).toMatchObject({
      processed: false,
      strikes: 1,
      last_error: "forge_head_mismatch",
    });
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests).toMatchObject([
      { number: 12, head_sha: HEAD_1 },
    ]);
    // The API catches up; the retry records the push.
    github.putPullRequest(t.repositoryId, {
      number: 12,
      headSha: HEAD_1B,
      baseSha: BASE,
      updatedAt: tick(),
    });
    await makeRetriesDue();
    await drainAll();
    expect(await inboxRow(push.deliveryId)).toMatchObject({ outcome: "pr_mirrored" });
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests).toMatchObject([
      { number: 12, head_sha: HEAD_1B, diff_truncation: null },
    ]);
  });

  it("review round 1: a compare 404 for a just-pushed head is retried before it is recorded", async () => {
    const t = await tenant();
    github.putDiff(t.repositoryId, { baseSha: BASE, headSha: HEAD_2 }, "missing");
    const { deliveryId } = await change(t, "opened", {
      number: 13,
      headSha: HEAD_2,
      baseSha: BASE,
    });
    await drainPullRequests();
    expect(await inboxRow(deliveryId)).toMatchObject({
      processed: false,
      strikes: 1,
      last_error: "forge_diff_unavailable",
    });
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests).toEqual([]);
    github.putDiff(t.repositoryId, { baseSha: BASE, headSha: HEAD_2 }, "+arrived\n");
    await makeRetriesDue();
    await drainAll();
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests).toMatchObject([
      { number: 13, diff_truncation: null, diff_bytes: Buffer.byteLength("+arrived\n") },
    ]);
  });

  it("review round 1: an `unavailable` reading is repaired by the next event and by the rebuild", async () => {
    const t = await tenant();
    github.putDiff(t.repositoryId, { baseSha: BASE, headSha: HEAD_3 }, "missing");
    const { deliveryId } = await change(t, "opened", {
      number: 14,
      headSha: HEAD_3,
      baseSha: BASE,
    });
    await drainAll();
    // After the retry window, GitHub's answer is believed and recorded as unavailable.
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "pr_mirrored" });
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests).toMatchObject([
      { number: 14, diff_truncated: true, diff_truncation: "unavailable" },
    ]);
    // GitHub has the diff again: the rebuild does not count `unavailable` as read.
    github.putDiff(t.repositoryId, { baseSha: BASE, headSha: HEAD_3 }, "+back\n");
    const report = await rebuildRepositoryMirror({ db: workerDb, forge }, t.fullName);
    expect(report).toMatchObject({
      listed: 1,
      mirrored: 1,
      unchanged: 0,
      revisionsRecorded: 1,
      truncatedDiffs: 0,
    });
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests).toMatchObject([
      {
        number: 14,
        diff_truncated: false,
        diff_truncation: null,
        diff_bytes: Buffer.byteLength("+back\n"),
      },
    ]);
    // A later event for the same head also repairs one (here: nothing left to repair).
    github.putDiff(t.repositoryId, { baseSha: BASE, headSha: HEAD_4 }, "missing");
    const other = await change(t, "opened", { number: 15, headSha: HEAD_4, baseSha: BASE });
    await drainAll();
    expect(await inboxRow(other.deliveryId)).toMatchObject({ outcome: "pr_mirrored" });
    github.putDiff(t.repositoryId, { baseSha: BASE, headSha: HEAD_4 }, "+later\n");
    await change(t, "reopened", { number: 15, headSha: HEAD_4, baseSha: BASE });
    await drainAll();
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests[1]).toMatchObject({
      number: 15,
      diff_truncation: null,
    });
  });

  it("review round 1: diff size and sha256 are those of the raw bytes, never above the cap", async () => {
    const t = await tenant();
    // A Latin-1 diff (invalid UTF-8) longer than the cap.
    const line = Buffer.concat([Buffer.from("+caf"), Buffer.alloc(95, 0xe9), Buffer.from("\n")]);
    const raw = Buffer.concat(
      Array.from({ length: Math.ceil(MIRROR_DIFF_MAX_BYTES / line.byteLength) + 5 }, () => line),
    );
    github.putDiff(t.repositoryId, { baseSha: BASE, headSha: HEAD_5 }, raw);
    await change(t, "opened", { number: 16, headSha: HEAD_5, baseSha: BASE });
    await drainAll();
    const [mirrored] = (await mirrorState(t.orgId, t.repositoryId)).pullRequests;
    expect(mirrored).toMatchObject({ diff_truncation: "max_bytes" });
    expect(mirrored!.diff_bytes).toBeLessThanOrEqual(MIRROR_DIFF_MAX_BYTES);
    const prefix = raw.subarray(0, mirrored!.diff_bytes as number);
    expect(prefix.byteLength % line.byteLength).toBe(0);
    expect(mirrored!.diff_sha256).toBe(createHash("sha256").update(prefix).digest("hex"));
  });

  it("a merge records the state without reading the unchanged head's diff again", async () => {
    const t = await tenant();
    await change(t, "opened", { number: 7, headSha: HEAD_2, baseSha: BASE });
    await drainAll();
    const diffs = compareReads();
    await change(t, "closed", { number: 7, headSha: HEAD_2, baseSha: BASE, merged: true });
    await drainAll();
    expect(compareReads()).toBe(diffs);
    const state = await mirrorState(t.orgId, t.repositoryId);
    expect(state.pullRequests).toMatchObject([{ number: 7, state: "merged" }]);
    expect(state.pullRequests[0]!.closed_at).not.toBeNull();
  });

  it("planted rows for things GitHub does not have write nothing", async () => {
    const t = await tenant();
    const unknownPr = await post(
      "pull_request",
      pullRequestPayload("opened", {
        installationId: t.installationId,
        repositoryId: t.repositoryId,
        number: 404,
      }),
    );
    const otherRepo = await post(
      "pull_request",
      pullRequestPayload("opened", {
        installationId: t.installationId,
        repositoryId: 999_999,
        number: 1,
      }),
    );
    const unknownInstallation = await post(
      "pull_request",
      pullRequestPayload("opened", {
        installationId: 999_999,
        repositoryId: t.repositoryId,
        number: 1,
      }),
    );
    // Planted straight into the inbox with the server's credential (no signature needed).
    const planted = randomUUID();
    await serverDb.recordWebhookDelivery({
      forge: "github",
      deliveryId: planted,
      payloadSha256: randomUUID().replaceAll("-", "").repeat(2),
      event: {
        type: "pull_request.opened",
        installationId: t.installationId,
        repositoryId: t.repositoryId,
        number: 405,
        headSha: HEAD_1,
        merged: false,
      },
    });
    await drainAll();
    expect(await inboxRow(planted)).toMatchObject({ outcome: "pull_request_not_found" });
    expect(await inboxRow(unknownPr.deliveryId)).toMatchObject({
      outcome: "pull_request_not_found",
    });
    expect(await inboxRow(otherRepo.deliveryId)).toMatchObject({
      outcome: "repository_inaccessible",
    });
    expect(await inboxRow(unknownInstallation.deliveryId)).toMatchObject({
      outcome: "installation_not_found",
    });
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests).toEqual([]);
    const repos = await superuser.query("select 1 from repos where org_id = $1", [t.orgId]);
    expect(repos.rows).toEqual([]);
  });

  it("a suspended installation is not read on behalf of; its events finish without effect", async () => {
    const t = await tenant();
    github.install(
      t.installationId,
      { id: t.installationId + 100_000, login: `acct-${t.installationId}`, type: "Organization" },
      { suspended: true },
    );
    const mints = github.tokens.mints.length;
    const { deliveryId } = await change(t, "opened", { number: 8, headSha: HEAD_1 });
    await drainAll();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "installation_suspended" });
    expect(github.tokens.mints.length).toBe(mints);
  });

  it("waits for the org when the pull request lane runs ahead of the installation lane", async () => {
    const installationId = nextInstallation++;
    const accountId = installationId + 100_000;
    const repositoryId = nextRepository++;
    const login = `acct-${installationId}`;
    github.install(installationId, { id: accountId, login, type: "Organization" });
    github.addRepository(installationId, { id: repositoryId, fullName: `${login}/api` });
    github.putPullRequest(repositoryId, { number: 1, headSha: HEAD_1, updatedAt: tick() });
    await post(
      "installation",
      installationPayload("created", { installationId, accountId, login }),
    );
    const pr = await post(
      "pull_request",
      pullRequestPayload("opened", { installationId, repositoryId, number: 1, headSha: HEAD_1 }),
    );
    await drainPullRequests();
    expect(await inboxRow(pr.deliveryId)).toMatchObject({
      processed: false,
      strikes: 1,
      last_error: "org_not_ready",
    });
    await drainInstallations();
    await makeRetriesDue();
    await drainAll();
    expect(await inboxRow(pr.deliveryId)).toMatchObject({ outcome: "pr_mirrored" });
  });

  it("gives up waiting for an org that never comes after the contradiction window", async () => {
    const installationId = nextInstallation++;
    const repositoryId = nextRepository++;
    github.install(installationId, {
      id: installationId + 100_000,
      login: "no-org",
      type: "Organization",
    });
    github.addRepository(installationId, { id: repositoryId, fullName: "no-org/api" });
    const pr = await post(
      "pull_request",
      pullRequestPayload("opened", { installationId, repositoryId, number: 1 }),
    );
    for (let i = 0; i < CONTRADICTION_ATTEMPTS + 1; i++) {
      await drainPullRequests();
      await makeRetriesDue();
    }
    expect(await inboxRow(pr.deliveryId)).toMatchObject({ processed: true, outcome: "no_org" });
  });

  it("a GitHub outage while reading retries without writing or striking, and still revokes the token", async () => {
    const t = await tenant();
    github.putPullRequest(t.repositoryId, { number: 9, headSha: HEAD_1, updatedAt: tick() });
    github.failRoute("pull", 502);
    const { deliveryId } = await post(
      "pull_request",
      pullRequestPayload("opened", {
        installationId: t.installationId,
        repositoryId: t.repositoryId,
        number: 9,
        headSha: HEAD_1,
      }),
    );
    await drainPullRequests();
    expect(await inboxRow(deliveryId)).toMatchObject({
      processed: false,
      strikes: 0,
      last_error: "forge_http_502",
    });
    expect((await mirrorState(t.orgId, t.repositoryId)).pullRequests).toEqual([]);
    expect(github.tokens.revoked).toBe(github.tokens.issued.length);
    await makeRetriesDue();
    await drainAll();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "pr_mirrored" });
  });

  it("keeps tenants apart: each installation's events land in its own org only", async () => {
    const a = await tenant();
    const b = await tenant();
    await change(a, "opened", { number: 1, headSha: HEAD_1 });
    await change(b, "opened", { number: 1, headSha: HEAD_2 });
    await drainAll();
    expect((await mirrorState(a.orgId, a.repositoryId)).pullRequests).toMatchObject([
      { number: 1, head_sha: HEAD_1 },
    ]);
    expect((await mirrorState(b.orgId, b.repositoryId)).pullRequests).toMatchObject([
      { number: 1, head_sha: HEAD_2 },
    ]);
    expect((await mirrorState(a.orgId, b.repositoryId)).pullRequests).toEqual([]);
    // A tenant's rebuild leaves the other alone.
    const other = await mirrorState(b.orgId, b.repositoryId);
    await rebuildRepositoryMirror({ db: workerDb, forge }, a.fullName);
    expect(await mirrorState(b.orgId, b.repositoryId)).toEqual(other);
  });

  it("an installation event and a pull request event of one installation run in separate lanes", async () => {
    const t = await tenant();
    // A pending installation row (GitHub still has the installation: a contradiction, retried).
    await post(
      "installation",
      installationPayload("deleted", {
        installationId: t.installationId,
        accountId: t.installationId + 100_000,
        login: `acct-${t.installationId}`,
      }),
    );
    const { deliveryId } = await change(t, "opened", { number: 2, headSha: HEAD_1 });
    await drainAll();
    expect(await inboxRow(deliveryId)).toMatchObject({ outcome: "pr_mirrored" });
    await drainInstallations();
  });
});

describe("hygiene", () => {
  it("logs and the database never hold an installation token, a diff, a title or a login", async () => {
    const all = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(10);
    expect(all).toContain("pull request event processed");
    for (const token of github.tokens.issued) expect(all).not.toContain(token);
    expect(all).not.toContain(PLANTED.title);
    expect(all).not.toContain("Add invite flow");
    expect(all).not.toContain("octo-dev");
    expect(all).not.toContain("diff-content-marker");
    expect(all).not.toContain("diff --git");
    const dump = await pgs.dump();
    expect(dump).toContain("CREATE TABLE public.pr_revisions");
    for (const token of github.tokens.issued) expect(dump).not.toContain(token);
    expect(dump).not.toContain("diff-content-marker");
    expect(dump).not.toContain("invalid email");
  });
});
