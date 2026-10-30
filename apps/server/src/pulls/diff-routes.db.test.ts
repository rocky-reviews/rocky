import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AccessDecision,
  ForgePullRequest,
  RepositoryAccessRequest,
} from "@rocky-reviews/core";
import { generateLocalKek, LocalKeyWrapper } from "@rocky-reviews/crypto";
import {
  createDb,
  recordRevision,
  upsertLoginMember,
  upsertPullRequest,
  upsertRepository,
  type Db,
} from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import { pr847Diff } from "@rocky-reviews/evals/pr-847/diff";
import {
  createGitHubForge,
  createGitHubLogin,
  githubEndpoints,
  parseGitHubAppAuth,
} from "@rocky-reviews/forge-github";
import {
  fakeGitHubApi,
  FIXTURE_APP_ID,
  testAppKeys,
  type FakeGitHubApi,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json" with { type: "json" };
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseDiffData } from "../../../web/src/data/diff-data.js";
import { buildApp } from "../app.js";
import { randomToken, sha256 } from "../auth/cookies.js";
import { createRateLimits, DEFAULT_RATE_LIMITS } from "../security/rate-limit.js";
import { loadWebApp } from "../web-app.js";
import { createPullRequestDiffReader, PULL_REQUEST_DIFF_MAX_BYTES } from "./diff-reader.js";

/**
 * H4-3 (ADR 0034): the PR's diff on demand, on a real Postgres as the browser asks for it
 * (session cookie), read from a fake GitHub through the mirror's own forge adapter (ADR 0010):
 * allow, every refusal (unknown, another org's, denied, no check, no reader), head moved,
 * missing commits, truncation and GitHub's refusal, outages, the token's scope and revocation,
 * the per-member rate limit, the short cache behind a fresh access check, and logs that carry
 * no diff content, token or name. Every 200 answer goes through the web app's own
 * `parseDiffData` (the contract). Who may call it is in `auth/policy.db.test.ts`.
 */

const PUBLIC = new URL("https://rocky.example.com/");
const SESSION = "__Host-rocky_session";
const SECRET = randomBytes(32);
const HEAD = pr847.provenance.head.sha;
const BASE = pr847.provenance.base.sha;
const FORGE_REPO = 5001;
const INSTALLATION = 181;
const keys = testAppKeys();
const appAuth = parseGitHubAppAuth({
  appId: String(FIXTURE_APP_ID),
  privateKey: keys.privateKeyPem,
});

let pgs: TestPostgres;
let db: Db;
let A: SeededOrg;
let B: SeededOrg;
let app: FastifyInstance;
let github: FakeGitHubApi;
let lines: string[] = [];
let accessAnswer: AccessDecision;
let accessAsked: RepositoryAccessRequest[] = [];
let dana: string;
let danaMember: string;
let eve: string;
let eveMember: string;
let danaB: string;
let repoA: string;
let now = Date.parse("2026-10-30T10:00:00Z");
const clock = { now: () => new Date(now) };

let webRoot: string;
const WEB_FILES: Readonly<Record<string, string>> = {
  "index.html":
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rocky</title><script type="module" crossorigin src="/assets/index-abc123.js"></script></head><body><div id="app"></div></body></html>',
  "assets/index-abc123.js": "console.log(1)",
};

type BuildOptions = {
  withoutAccessCheck?: boolean;
  withoutDiffs?: boolean;
  /** The `diff` rate limit (per member, per minute). */
  diffLimit?: number;
};

const build = (options: BuildOptions = {}) => {
  const log = createLogger("pull-diff-test", {
    level: "debug",
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  const forge = createGitHubForge({
    auth: appAuth,
    api: githubEndpoints({}).api,
    clock,
    fetch: github.fetch,
  });
  return buildApp({
    checkDatabase: () => Promise.resolve(true),
    log,
    web: loadWebApp(webRoot),
    rateLimits: createRateLimits({
      rules: {
        ...DEFAULT_RATE_LIMITS,
        diff: { max: options.diffLimit ?? DEFAULT_RATE_LIMITS.diff.max, windowMs: 60_000 },
      },
      trustProxy: { kind: "none" },
    }),
    auth: {
      publicUrl: PUBLIC,
      cookieSecure: true,
      secret: SECRET,
      login: createGitHubLogin({
        endpoints: githubEndpoints({}),
        clientId: "Iv23liPullDiffTest01",
        clientSecret: "test-only-client-secret-pulldiff-012345",
        fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
      }),
      db,
      keys: new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]),
    },
    ...(options.withoutDiffs === true
      ? {}
      : { pullRequestDiffs: createPullRequestDiffReader({ forge, clock }) }),
    ...(options.withoutAccessCheck === true
      ? {}
      : {
          repositoryAccess: {
            check: async (request: RepositoryAccessRequest) => {
              accessAsked.push(request);
              return accessAnswer;
            },
          },
        }),
  });
};

const forgePr = (number: number, overrides: Partial<ForgePullRequest> = {}): ForgePullRequest => ({
  ref: { installationId: INSTALLATION, repositoryId: FORGE_REPO, number },
  title: "Team invitations with expiring links",
  authorLogin: "dana-k",
  state: "open",
  headSha: HEAD,
  baseSha: BASE,
  openedAt: new Date("2026-10-20T09:00:00Z"),
  closedAt: null,
  updatedAt: new Date("2026-10-25T12:00:00Z"),
  changedFiles: 9,
  additions: 215,
  deletions: 3,
  ...overrides,
});

const DIFF_READING = { bytes: 10, sha256: "e".repeat(64), truncation: null };

/** Mirrors PR `number` in org A (head revision recorded unless `revision: false`). */
const mirrored = async (
  number: number,
  pr: Partial<ForgePullRequest> = {},
  options: { revision?: boolean } = {},
): Promise<string> =>
  db.withOrg(A.orgId, async (tx) => {
    const forge = forgePr(number, pr);
    const created = await upsertPullRequest(tx, repoA, forge);
    if (options.revision !== false) await recordRevision(tx, created.id, forge, DIFF_READING);
    return created.id;
  });

const sessionIn = async (org: SeededOrg, forgeUserId: number, login: string) => {
  const memberId = await db.withOrg(org.orgId, async (tx) => {
    const row = await upsertLoginMember(tx, { forgeUserId, login });
    return row!.memberId;
  });
  const at = new Date();
  const { userId } = await db.sessions.upsertUser("github", forgeUserId, at);
  const token = randomToken();
  await db.sessions.createSession({
    tokenSha256: sha256(token),
    userId,
    orgs: [{ orgId: org.orgId, memberId }],
    activeOrgId: org.orgId,
    now: at,
    idleTimeoutSeconds: 3600,
    expiresAt: new Date(at.getTime() + 3_600_000),
  });
  return { token, memberId };
};

const get = (token: string | null, url: string, on: FastifyInstance = app) =>
  on.inject({
    method: "GET",
    url,
    headers: token === null ? {} : { cookie: `${SESSION}=${token}` },
  });

const DIFF_PATTERN = "/api/repos/:owner/:repo/pulls/:number/diff";
const diffPath = (number: number, owner = "acme", repo = "rocky-app") =>
  `/api/repos/${owner}/${repo}/pulls/${number}/diff`;

type Answer = { headSha: string; diff: string; truncation: string | null };

/** The GitHub requests the fake saw since `from`, as `METHOD path`. */
const githubCalls = (from: number) =>
  github.requests.slice(from).map((r) => `${r.method} ${r.path.replace(/^\//, "")}`);

/** A 200 answer, checked with the web app's own parser. */
const served = async (number: number, token = dana): Promise<Answer> => {
  const res = await get(token, diffPath(number));
  expect(res.statusCode, res.body).toBe(200);
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["content-type"]).toContain("application/json");
  const body = res.json() as Answer;
  expect(() => parseDiffData(body)).not.toThrow();
  return body;
};

/** A GitHub that holds the mirrored PR at the mirror's head with pr-847's diff. */
const freshGitHub = () => {
  github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey, now: () => now });
  github.install(INSTALLATION, { id: 1_000_181, login: "acme", type: "Organization" });
  github.addRepository(INSTALLATION, { id: FORGE_REPO, fullName: "acme/rocky-app", private: true });
  github.putPullRequest(FORGE_REPO, { number: 847, headSha: HEAD, baseSha: BASE });
  github.putDiff(FORGE_REPO, { baseSha: BASE, headSha: HEAD }, pr847Diff());
};

beforeAll(async () => {
  webRoot = mkdtempSync(join(tmpdir(), "rocky-pull-diff-web-"));
  for (const [path, body] of Object.entries(WEB_FILES)) {
    mkdirSync(join(webRoot, path, ".."), { recursive: true });
    writeFileSync(join(webRoot, path), body);
  }
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 6 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: INSTALLATION }),
    await seedOrg(w, newOrgId(), { installationId: 182 }),
  ]);
  repoA = await db.withOrg(A.orgId, (tx) =>
    upsertRepository(tx, {
      id: FORGE_REPO,
      fullName: "acme/rocky-app",
      private: true,
      defaultBranch: "main",
    }),
  );
  await mirrored(847);
  // Org B has a repository of the same name and a PR of the same number: never served to A.
  await db.withOrg(B.orgId, async (tx) => {
    const repo = await upsertRepository(tx, {
      id: 6001,
      fullName: "acme/rocky-app",
      private: true,
      defaultBranch: "main",
    });
    await upsertPullRequest(tx, repo, { ...forgePr(900), title: "Org B's own PR" });
  });
  ({ token: dana, memberId: danaMember } = await sessionIn(A, 4101, "dana-k"));
  ({ token: eve, memberId: eveMember } = await sessionIn(A, 4103, "eve"));
  ({ token: danaB } = await sessionIn(B, 4102, "bo"));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await pgs?.stop();
  if (webRoot !== undefined) rmSync(webRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  lines = [];
  accessAsked = [];
  accessAnswer = { allowed: true, cached: false, expiresAt: new Date(now + 60_000) };
  freshGitHub();
  await app?.close();
  app = build();
  await app.ready();
});

describe("GET /api/repos/:owner/:repo/pulls/:number/diff: the diff of the mirrored head", () => {
  it("reads the diff from GitHub on a token for that one repository, read-only, revoked after", async () => {
    const body = await served(847);
    expect(body).toEqual({ headSha: HEAD, diff: pr847Diff(), truncation: null });
    expect(parseDiffData(body).files.size).toBe(9);
    // The member and the repository come from the session and the row; nothing from the URL.
    expect(accessAsked).toEqual([
      { orgId: A.orgId, memberId: danaMember, repositoryId: FORGE_REPO },
    ]);
    // One token: the mirror's shape (ADR 0010 §2), for exactly this repository, read-only.
    expect(github.tokens.mints).toEqual([
      {
        installationId: INSTALLATION,
        body: {
          repository_ids: [FORGE_REPO],
          permissions: { contents: "read", pull_requests: "read" },
        },
      },
    ]);
    expect(github.tokens.issued).toHaveLength(1);
    expect(github.tokens.revoked).toBe(1);
    // The head is verified before the diff is read, pinned to the mirror's two commits.
    expect(githubCalls(0)).toEqual([
      `POST app/installations/${INSTALLATION}/access_tokens`,
      "GET repos/acme/rocky-app/pulls/847",
      `GET repos/acme/rocky-app/compare/${BASE}...${HEAD}`,
      "DELETE installation/token",
    ]);
    expect(github.requests.every((r) => r.authorized)).toBe(true);
  });

  it("serves a second read from the short cache, after a fresh access check for that member", async () => {
    await served(847);
    const from = github.requests.length;
    await served(847, eve);
    expect(githubCalls(from)).toEqual([]);
    expect(github.tokens.mints).toHaveLength(1);
    expect(accessAsked.map((a) => a.memberId)).toEqual([danaMember, eveMember]);
    // A member GitHub no longer lets read gets nothing from the cache either.
    accessAnswer = { allowed: false, reason: "no_read_permission", cached: false };
    const res = await get(eve, diffPath(847));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(githubCalls(from)).toEqual([]);
    // After the TTL the diff is read again.
    accessAnswer = { allowed: true, cached: false, expiresAt: new Date(now + 60_000) };
    now += 60_001;
    await served(847);
    expect(github.tokens.mints).toHaveLength(2);
    now -= 60_001;
  });

  it("takes GitHub's base when the mirror has no revision of the head yet", async () => {
    await mirrored(848, {}, { revision: false });
    github.putPullRequest(FORGE_REPO, { number: 848, headSha: HEAD, baseSha: BASE });
    expect((await served(848)).headSha).toBe(HEAD);
    expect(githubCalls(0)).toContain(`GET repos/acme/rocky-app/compare/${BASE}...${HEAD}`);
  });

  it("GitHub's head moved since the mirror's: 409 head_moved, no diff read, token revoked", async () => {
    github.putPullRequest(FORGE_REPO, { number: 847, headSha: "f".repeat(40), baseSha: BASE });
    const res = await get(dana, diffPath(847));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "head_moved" });
    expect(githubCalls(0).some((c) => c.includes("/compare/"))).toBe(false);
    expect(github.tokens.revoked).toBe(1);
    // Nothing was cached: once the mirror catches up (here: GitHub again), the diff is read.
    github.putPullRequest(FORGE_REPO, { number: 847, headSha: HEAD, baseSha: BASE });
    expect((await served(847)).headSha).toBe(HEAD);
  });

  it("GitHub has no diff for the mirrored commits (force-pushed away): 409 commits_unavailable", async () => {
    github.putDiff(FORGE_REPO, { baseSha: BASE, headSha: HEAD }, "missing");
    const res = await get(dana, diffPath(847));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "commits_unavailable" });
    expect(github.tokens.revoked).toBe(1);
  });

  it("a diff longer than the mirror's cap is cut to whole files and flagged; GitHub's refusal is 413", async () => {
    const small =
      "diff --git a/small.txt b/small.txt\n--- /dev/null\n+++ b/small.txt\n@@ -0,0 +1 @@\n+one\n";
    const line = `+${"x".repeat(98)}\n`;
    const long = `${small}diff --git a/big.txt b/big.txt\n--- /dev/null\n+++ b/big.txt\n@@ -0,0 +1,20000 @@\n${line.repeat(20_000)}`;
    expect(Buffer.byteLength(long)).toBeGreaterThan(PULL_REQUEST_DIFF_MAX_BYTES);
    github.putDiff(FORGE_REPO, { baseSha: BASE, headSha: HEAD }, long);
    const body = await served(847);
    // The cut file is left out whole: the page shows complete files and says the rest is on GitHub.
    expect(body).toEqual({ headSha: HEAD, diff: small, truncation: "max_bytes" });
    const data = parseDiffData(body);
    expect(data.truncated).toBe(true);
    expect([...data.files.keys()]).toEqual(["small.txt"]);

    const head = "a1".repeat(20);
    await mirrored(850, { headSha: head });
    github.putPullRequest(FORGE_REPO, { number: 850, headSha: head, baseSha: BASE });
    github.putDiff(FORGE_REPO, { baseSha: BASE, headSha: head }, "too_large");
    const res = await get(dana, diffPath(850));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "diff_too_large" });
    expect(github.tokens.revoked).toBe(2);
  });

  it("a non-UTF-8 diff is shown with replacement characters, never refused", async () => {
    github.putDiff(
      FORGE_REPO,
      { baseSha: BASE, headSha: HEAD },
      Buffer.from("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-caf\xe9\n+cafe\n", "latin1"),
    );
    const body = await served(847);
    expect(body.diff).toContain("caf�");
  });
});

describe("GET /api/repos/:owner/:repo/pulls/:number/diff: refusals", () => {
  it("unknown PR, unknown repository and another org's PR: the same 404, nothing asked of GitHub", async () => {
    for (const url of [diffPath(999_999), diffPath(847, "acme", "elsewhere"), diffPath(900)]) {
      const res = await get(dana, url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: "not_found" });
    }
    expect(github.requests).toEqual([]);
    expect(accessAsked).toEqual([]);
    // Org B's member reads neither A's #847 nor, for want of a mirror, their own #900's diff
    // from A's GitHub answers: B's own repository id is unknown to the installation.
    expect((await get(danaB, diffPath(847))).statusCode).toBe(404);
  });

  it("GitHub access denied: the same 404 as an unknown PR, and no token is minted", async () => {
    accessAnswer = { allowed: false, reason: "no_read_permission", cached: false };
    const res = await get(dana, diffPath(847));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(accessAsked).toHaveLength(1);
    expect(github.requests).toEqual([]);
    // A transient deny (GitHub down for the member's question) answers the same.
    accessAnswer = { allowed: false, reason: "forge_unavailable", cached: false };
    expect((await get(dana, diffPath(847))).statusCode).toBe(404);
    expect(github.requests).toEqual([]);
  });

  it("the installation can no longer read the repository, or GitHub has no such PR: 404", async () => {
    github.removeRepository(FORGE_REPO);
    const res = await get(dana, diffPath(847));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "not_found" });
    expect(github.tokens.issued).toEqual([]);

    github.addRepository(INSTALLATION, {
      id: FORGE_REPO,
      fullName: "acme/rocky-app",
      private: true,
    });
    await mirrored(849);
    // The mirror has #849; GitHub does not (deleted, or a planted row).
    expect((await get(dana, diffPath(849))).statusCode).toBe(404);
    expect(github.tokens.revoked).toBe(1);
  });

  it("a disabled repository is not served", async () => {
    await db.withOrg(A.orgId, (tx) =>
      tx.query("update repos set enabled = false where id = $1", [repoA]),
    );
    try {
      expect((await get(dana, diffPath(847))).statusCode).toBe(404);
      expect(github.requests).toEqual([]);
    } finally {
      await db.withOrg(A.orgId, (tx) =>
        tx.query("update repos set enabled = true where id = $1", [repoA]),
      );
    }
  });

  it("a GitHub outage: 502 forge_unavailable, nothing cached, the token revoked when one was minted", async () => {
    github.failRoute("compare", 502);
    let res = await get(dana, diffPath(847));
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "forge_unavailable" });
    expect(github.tokens.revoked).toBe(1);
    github.failRoute("pull", 500);
    res = await get(dana, diffPath(847));
    expect(res.statusCode).toBe(502);
    expect(github.tokens.revoked).toBe(2);
    github.failRoute("token", 503);
    res = await get(dana, diffPath(847));
    expect(res.statusCode).toBe(502);
    // The outage over, the next request reads the diff.
    expect((await served(847)).headSha).toBe(HEAD);
  });

  it("without the repository access check: 503, before reading anything", async () => {
    const prev = app;
    app = build({ withoutAccessCheck: true });
    try {
      const res = await get(dana, diffPath(847));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "access_check_unavailable" });
      expect(github.requests).toEqual([]);
    } finally {
      await app.close();
      app = prev;
    }
  });

  it("without a diff reader (no app key): 503, before reading anything", async () => {
    const prev = app;
    app = build({ withoutDiffs: true });
    try {
      const res = await get(dana, diffPath(847));
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "diffs_unavailable" });
      expect(accessAsked).toEqual([]);
    } finally {
      await app.close();
      app = prev;
    }
  });

  it("without a session: 401", async () => {
    const res = await get(null, diffPath(847));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthenticated" });
  });

  it("an address that cannot name a pull request: 400, nothing asked", async () => {
    for (const url of [
      diffPath(0),
      "/api/repos/acme/rocky-app/pulls/01/diff",
      diffPath(1, "-acme"),
      diffPath(1, "acme", "a%20b"),
    ]) {
      const res = await get(dana, url);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toEqual({ error: "invalid_pull_request" });
    }
    expect(accessAsked).toEqual([]);
    expect(github.requests).toEqual([]);
  });

  it("rate-limits each member: 429 with Retry-After past the limit; another member is unaffected", async () => {
    const prev = app;
    app = build({ diffLimit: 2 });
    try {
      await served(847);
      await served(847);
      const res = await get(dana, diffPath(847));
      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: "rate_limited" });
      expect(res.headers["retry-after"]).toMatch(/^[1-9][0-9]*$/);
      expect(res.headers["cache-control"]).toBe("no-store");
      await served(847, eve);
      // A limited request reads nothing: no access check, no GitHub call.
      expect(accessAsked.map((a) => a.memberId)).toEqual([danaMember, danaMember, eveMember]);
    } finally {
      await app.close();
      app = prev;
    }
  });

  it("logs carry ids, sizes, digests and outcomes: never diff content, a token or a name", async () => {
    // Head moved first (a cached diff would otherwise answer before GitHub is asked).
    github.putPullRequest(FORGE_REPO, { number: 847, headSha: "f".repeat(40), baseSha: BASE });
    await get(dana, diffPath(847));
    github.putPullRequest(FORGE_REPO, { number: 847, headSha: HEAD, baseSha: BASE });
    await served(847);
    await get(dana, diffPath(999_997));
    const all = lines.map((l) => JSON.parse(l) as { req?: { url?: string } });
    expect(all.filter((l) => l.req !== undefined).map((l) => l.req?.url)).toEqual(
      expect.arrayContaining([DIFF_PATTERN]),
    );
    const diff = pr847Diff();
    const distinctive = diff.split("\n").filter((l) => /^[+-][^+-]/.test(l) && l.length > 20);
    expect(distinctive.length).toBeGreaterThan(50);
    for (const line of lines) {
      expect(line).not.toMatch(/rocky-app|acme\/|dana-k|Team invitations/);
      for (const token of github.tokens.issued) expect(line).not.toContain(token);
      for (const content of distinctive.slice(0, 20)) expect(line).not.toContain(content);
      expect(line).not.toContain("INVITE_TTL_MS");
    }
    const entries = lines
      .map((l) => JSON.parse(l) as { pull_diff_route?: Record<string, unknown> })
      .filter((l) => l.pull_diff_route !== undefined)
      .map((l) => l.pull_diff_route);
    expect(entries).toContainEqual({
      outcome: "served",
      orgId: A.orgId,
      pullRequestId: expect.any(String),
      bytes: Buffer.byteLength(diff),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      truncation: null,
      cached: false,
    });
    expect(entries).toContainEqual(
      expect.objectContaining({ outcome: "head_moved", orgId: A.orgId }),
    );
    expect(entries).toContainEqual({ outcome: "not_found", orgId: A.orgId });
    // The answers carry no token either.
    const res = await get(dana, diffPath(847));
    for (const token of github.tokens.issued) expect(res.body).not.toContain(token);
  });
});
