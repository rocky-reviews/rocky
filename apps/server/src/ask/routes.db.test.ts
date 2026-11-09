import { randomBytes } from "node:crypto";
import type {
  AccessDecision,
  EmbeddingRoleClient,
  EmbeddingSpace,
  ForgePullRequest,
  LlmRoles,
  LlmUsageRecord,
  OrgId,
  RepositoryAccessRequest,
} from "@rocky-reviews/core";
import { LlmCallError } from "@rocky-reviews/core";
import { scriptedRoles, type Script } from "@rocky-reviews/core/testing";
import { generateLocalKek, LocalKeyWrapper } from "@rocky-reviews/crypto";
import {
  beginCodeIndexRun,
  createDb,
  enqueueCodeIndex,
  finishCodeIndex,
  upsertLoginMember,
  upsertPullRequest,
  upsertRepository,
  writeIndexedFiles,
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
import {
  createGitHubForge,
  createGitHubLogin,
  githubEndpoints,
  parseGitHubAppAuth,
} from "@rocky-reviews/forge-github";
import {
  fakeBlobSha,
  fakeGitHubApi,
  FIXTURE_APP_ID,
  testAppKeys,
  type FakeGitHubApi,
} from "@rocky-reviews/forge-github/testing";
import type { LlmUsageTargets } from "@rocky-reviews/llm";
import { createLogger } from "@rocky-reviews/log";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { csrfTokenFor, CSRF_HEADER, randomToken, sha256 } from "../auth/cookies.js";
import { createRateLimits, DEFAULT_RATE_LIMITS } from "../security/rate-limit.js";
import { askIndexView } from "./routes.js";

/**
 * P9-2 (ADR 0041): Ask on a real Postgres, as the browser asks (session cookie, CSRF header),
 * against an index written the way the worker writes it, with the code read from a fake GitHub
 * through the app's own forge adapter. The model is scripted; the embedder answers fixed vectors.
 * Covers the answer and its citations (only into lines the model was shown), every refusal, the
 * index's states, the token's scope and revocation, the commit check for an unsettled index, and
 * logs that carry no question, code, path or answer. Who may call it is in
 * `auth/policy.db.test.ts`.
 */

const PUBLIC = new URL("https://rocky.example.com/");
const ORIGIN = PUBLIC.origin;
const SESSION = "__Host-rocky_session";
const SECRET = randomBytes(32);
const FORGE_REPO = 7001;
const INSTALLATION = 191;
const COMMIT = "c".repeat(40);
const NEXT_COMMIT = "d".repeat(40);
const SPACE: EmbeddingSpace = {
  provider: "openai",
  model: "text-embedding-3-small",
  dimensions: 4,
};
const keys = testAppKeys();
const appAuth = parseGitHubAppAuth({
  appId: String(FIXTURE_APP_ID),
  privateKey: keys.privateKeyPem,
});

/** Planted in the code, the question and the answer: none of it may reach a log line. */
const MARKER = "zq-marker-7f3e";
const INVITE = Array.from({ length: 24 }, (_, i) =>
  i === 4 ? `export const accept = () => "${MARKER}-code";` : `// invite line ${i + 1}`,
).join("\n");
const OTHER = Array.from({ length: 6 }, (_, i) => `// other line ${i + 1}`).join("\n");
const INVITE_BLOB = fakeBlobSha(new TextEncoder().encode(INVITE));
const OTHER_BLOB = fakeBlobSha(new TextEncoder().encode(OTHER));

const TARGETS: LlmUsageTargets = {
  triage: { provider: "scripted", model: "scripted-triage" },
  review: { provider: "scripted", model: "scripted-review" },
  graph: { provider: "scripted", model: "scripted-graph" },
  ask: { provider: "scripted", model: "scripted-ask" },
  embed: { provider: SPACE.provider, model: SPACE.model },
};

let pgs: TestPostgres;
let db: Db;
let worker: Db;
let A: SeededOrg;
let B: SeededOrg;
let app: FastifyInstance;
let github: FakeGitHubApi;
let lines: string[] = [];
let accessAnswer: AccessDecision;
let accessAsked: RepositoryAccessRequest[] = [];
let dana: string;
let danaMember: string;
let bo: string;
let repoA: string;
let pullA: string;
let script: Script;
let calls: ReturnType<typeof scriptedRoles>["calls"] = [];
let embedVector: number[] = [1, 0, 0, 0];
let embedded: string[] = [];
/** Runs while the question is being embedded (between the route's state read and its search). */
let onEmbed: (() => Promise<void>) | undefined;

const embedding: EmbeddingRoleClient = {
  embed: async (request) => {
    embedded.push(...request.inputs);
    await onEmbed?.();
    return {
      vectors: request.inputs.map(() => embedVector),
      model: SPACE.model,
      provider: SPACE.provider,
      usage: { inputTokens: 7 },
    };
  },
};

const roles = (): LlmRoles => {
  const scripted = scriptedRoles((call) => script(call), {
    usage: () => ({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 0,
    }),
  });
  calls = scripted.calls;
  return { completion: scripted.roles.completion, embedding: () => embedding };
};

type BuildOptions = {
  withoutAsk?: boolean;
  askLimit?: number;
  askOrgLimit?: number;
  askOrgDayLimit?: number;
  space?: EmbeddingSpace;
  /** P9-3: a usage writer standing in for the `llm_usage` one. */
  recordUsage?: (orgId: OrgId, records: readonly LlmUsageRecord[]) => Promise<void>;
};

const build = (options: BuildOptions = {}) => {
  const log = createLogger("ask-test", {
    level: "debug",
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  const forge = createGitHubForge({
    auth: appAuth,
    api: githubEndpoints({}).api,
    clock: { now: () => new Date() },
    fetch: github.fetch,
  });
  return buildApp({
    checkDatabase: () => Promise.resolve(true),
    log,
    rateLimits: createRateLimits({
      rules: {
        ...DEFAULT_RATE_LIMITS,
        ask: { max: options.askLimit ?? DEFAULT_RATE_LIMITS.ask.max, windowMs: 60_000 },
        "ask.org": {
          max: options.askOrgLimit ?? DEFAULT_RATE_LIMITS["ask.org"].max,
          windowMs: 60_000,
        },
        "ask.org.day": {
          max: options.askOrgDayLimit ?? DEFAULT_RATE_LIMITS["ask.org.day"].max,
          windowMs: 86_400_000,
        },
      },
      trustProxy: { kind: "none" },
    }),
    auth: {
      publicUrl: PUBLIC,
      cookieSecure: true,
      secret: SECRET,
      login: createGitHubLogin({
        endpoints: githubEndpoints({}),
        clientId: "Iv23liAskRouteTest01",
        clientSecret: "test-only-client-secret-askroute-0123",
        fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch,
      }),
      db,
      keys: new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]),
    },
    repositoryAccess: {
      check: async (request: RepositoryAccessRequest) => {
        accessAsked.push(request);
        return accessAnswer;
      },
    },
    ...(options.withoutAsk === true
      ? {}
      : {
          ask: {
            llm: roles(),
            space: options.space ?? SPACE,
            usageTargets: TARGETS,
            forge,
            log,
            ...(options.recordUsage === undefined ? {} : { recordUsage: options.recordUsage }),
          },
        }),
  });
};

const forgePr = (number: number): ForgePullRequest => ({
  ref: { installationId: INSTALLATION, repositoryId: FORGE_REPO, number },
  title: "Team invitations",
  authorLogin: "dana-k",
  state: "open",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  openedAt: new Date("2026-10-20T09:00:00Z"),
  closedAt: null,
  updatedAt: new Date("2026-10-25T12:00:00Z"),
  changedFiles: 2,
  additions: 10,
  deletions: 1,
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

const ASK_URL = (number = 847, owner = "acme", repo = "rocky-app") =>
  `/api/repos/${owner}/${repo}/pulls/${number}/ask`;

const get = (token: string, url = ASK_URL()) =>
  app.inject({ method: "GET", url, headers: { cookie: `${SESSION}=${token}` } });

const post = (token: string, body: unknown, url = ASK_URL()) =>
  app.inject({
    method: "POST",
    url,
    headers: {
      cookie: `${SESSION}=${token}`,
      origin: ORIGIN,
      [CSRF_HEADER]: csrfTokenFor(SECRET, token),
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });

/** Writes an index of the two files at COMMIT, as the worker would, and finishes it `done`. */
const indexRepository = async (space: EmbeddingSpace = SPACE) => {
  await db.withOrg(A.orgId, (tx) => enqueueCodeIndex(tx, repoA, null));
  const [claim] = await worker.claimCodeIndexes({ limit: 5, leaseSeconds: 600 });
  if (claim === undefined) throw new Error("expected a claim");
  await db.withOrg(A.orgId, async (tx) => {
    await beginCodeIndexRun(tx, claim, space);
    await writeIndexedFiles(tx, claim, repoA, space, [
      {
        path: "src/auth/invite.ts",
        blobSha: INVITE_BLOB,
        language: "typescript",
        status: "indexed",
        chunks: [
          {
            ordinal: 0,
            startLine: 1,
            endLine: 10,
            kind: "function_declaration",
            inputSha256: "1".repeat(64),
            vector: [1, 0, 0, 0],
          },
          {
            ordinal: 1,
            startLine: 11,
            endLine: 24,
            kind: "function_declaration",
            inputSha256: "2".repeat(64),
            vector: [0.9, 0.1, 0, 0],
          },
        ],
      },
      {
        path: "src/other.ts",
        blobSha: OTHER_BLOB,
        language: "typescript",
        status: "indexed",
        chunks: [
          {
            ordinal: 0,
            startLine: 1,
            endLine: 6,
            kind: "window",
            inputSha256: "3".repeat(64),
            vector: [0, 0, 1, 0],
          },
        ],
      },
    ]);
    await finishCodeIndex(tx, claim, { kind: "done", indexedSha: COMMIT, spentTokens: 30 });
  });
};

const answer = (citations: { path: string; start: number; end: number }[], text = "x") =>
  ({ value: { answered: true, answer: text, citations } }) as const;

/** The GitHub requests the fake saw since `from`, as `METHOD path`. */
const githubCalls = (from: number) =>
  github.requests.slice(from).map((r) => `${r.method} ${r.path.replace(/^\//, "")}`);

const freshGitHub = () => {
  github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
  github.install(INSTALLATION, { id: 1_000_191, login: "acme", type: "Organization" });
  github.addRepository(INSTALLATION, { id: FORGE_REPO, fullName: "acme/rocky-app", private: true });
  github.putCode(
    FORGE_REPO,
    COMMIT,
    { "src/auth/invite.ts": INVITE, "src/other.ts": OTHER },
    { branch: "main" },
  );
};

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 6 });
  worker = createDb({ connectionString: pgs.workerUrl, max: 2 });
  [A, B] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId(), { installationId: INSTALLATION }),
    await seedOrg(w, newOrgId(), { installationId: 192 }),
  ]);
  repoA = await db.withOrg(A.orgId, (tx) =>
    upsertRepository(tx, {
      id: FORGE_REPO,
      fullName: "acme/rocky-app",
      private: true,
      defaultBranch: "main",
    }),
  );
  await db.withOrg(A.orgId, (tx) => upsertPullRequest(tx, repoA, forgePr(847)));
  pullA = await db.withOrg(A.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from pull_requests where org_id = $1 and repo_id = $2 and number = 847",
      [A.orgId, repoA],
    );
    return rows[0]!.id;
  });
  ({ token: dana, memberId: danaMember } = await sessionIn(A, 5101, "dana-k"));
  ({ token: bo } = await sessionIn(B, 5102, "bo"));
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
  await worker?.close();
  await pgs?.stop();
});

beforeEach(async () => {
  lines = [];
  accessAsked = [];
  embedded = [];
  embedVector = [1, 0, 0, 0];
  onEmbed = undefined;
  accessAnswer = { allowed: true, cached: false, expiresAt: new Date(Date.now() + 60_000) };
  script = () => answer([{ path: "src/auth/invite.ts", start: 4, end: 6 }], "It is `accept`.");
  freshGitHub();
  await db.withOrg(A.orgId, async (tx) => {
    await tx.query("delete from code_files where org_id = $1", [A.orgId]);
    await tx.query("delete from code_indexes where org_id = $1", [A.orgId]);
  });
  usageFrom = await lastUsageId();
  await app?.close();
  app = build();
  await app.ready();
});

/** The ledger is append-only: tests read the rows written since they started. */
let usageFrom = 0;
const lastUsageId = () =>
  db.withOrg(A.orgId, async (tx) => {
    const { rows } = await tx.query<{ id: string | null }>("select max(id) as id from llm_usage");
    return Number(rows[0]?.id ?? 0);
  });
const usageRows = (org = A.orgId) =>
  db.withOrg(org, async (tx) => {
    const { rows } = await tx.query<{
      role: string;
      repo_id: string | null;
      pull_request_id: string | null;
      analysis_id: string | null;
      outcome: string;
      usage_status: string;
      input_tokens: number | null;
    }>(
      `select role, repo_id, pull_request_id, analysis_id, outcome, usage_status, input_tokens
         from llm_usage where id > $1 order by id`,
      [usageFrom],
    );
    return rows;
  });

const noContentInLogs = () => {
  const text = lines.join("");
  expect(text).not.toContain(MARKER);
  expect(text).not.toContain("src/auth/invite.ts");
  expect(text).not.toContain("Who calls");
  expect(text).not.toContain("It is `accept`");
  expect(text).not.toContain("ghs_");
};

describe("POST /api/repos/:owner/:repo/pulls/:number/ask: an answer with citations", () => {
  it("answers from the index, citing only lines it was shown, on a read-only token revoked after", async () => {
    await indexRepository();
    const from = github.requests.length;
    const res = await post(dana, { question: `Who calls accept? ${MARKER}-question` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      status: "answered",
      answer: "It is `accept`.",
      citations: [{ path: "src/auth/invite.ts", startLine: 4, endLine: 6 }],
      indexedSha: COMMIT,
    });
    // The member and the repository come from the session and the row.
    expect(accessAsked).toEqual([
      { orgId: A.orgId, memberId: danaMember, repositoryId: FORGE_REPO },
    ]);
    // The question was embedded as a query; the model saw the question and the excerpts as
    // untrusted parts, numbered, with the code read from GitHub.
    expect(embedded).toEqual([`Who calls accept? ${MARKER}-question`]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.role).toBe("ask");
    expect(calls[0]!.labels).toEqual(["question", "code", "code", "code"]);
    expect(calls[0]!.untrusted[1]!.text).toContain(
      `5| export const accept = () => "${MARKER}-code";`,
    );
    // One token, for exactly this repository, contents read only; revoked after.
    expect(github.tokens.mints).toEqual([
      {
        installationId: INSTALLATION,
        body: { repository_ids: [FORGE_REPO], permissions: { contents: "read" } },
      },
    ]);
    expect(github.tokens.revoked).toBe(1);
    // A settled index: no tree read, each blob once.
    expect(
      githubCalls(from).filter(
        (c) => !c.includes("access_tokens") && !c.includes("installation/token"),
      ),
    ).toEqual([
      `GET repos/acme/rocky-app/git/blobs/${INVITE_BLOB}`,
      `GET repos/acme/rocky-app/git/blobs/${OTHER_BLOB}`,
    ]);
    noContentInLogs();
    // Every call is in the ledger (P9-3, migration 0023), written by the server's own login,
    // for this org, repository and pull request, and never as an analysis.
    expect(await usageRows()).toEqual([
      {
        role: "embed",
        repo_id: repoA,
        pull_request_id: pullA,
        analysis_id: null,
        outcome: "ok",
        usage_status: "reported",
        input_tokens: 7,
      },
      {
        role: "ask",
        repo_id: repoA,
        pull_request_id: pullA,
        analysis_id: null,
        outcome: "ok",
        usage_status: "reported",
        input_tokens: 100,
      },
    ]);
    expect(lines.join("")).not.toContain("ask_usage");
    const answered = lines
      .map((l) => JSON.parse(l) as { ask_route?: Record<string, unknown> })
      .find((l) => l.ask_route?.["outcome"] === "answered")?.ask_route;
    expect(answered).toMatchObject({ excerpts: 3, citations: 1, dropped: 0, hits: 3, blobs: 2 });
  });

  it("drops citations outside the excerpts; an answer left without one is no_answer", async () => {
    await indexRepository();
    script = () =>
      answer([
        { path: "src/auth/invite.ts", start: 1, end: 2 },
        { path: "src/auth/invite.ts", start: 23, end: 30 },
        { path: "src/nowhere.ts", start: 1, end: 1 },
      ]);
    const res = await post(dana, { question: "q" });
    expect(res.json()).toMatchObject({
      status: "answered",
      citations: [{ path: "src/auth/invite.ts", startLine: 1, endLine: 2 }],
    });
    script = () => answer([{ path: "src/nowhere.ts", start: 1, end: 1 }]);
    expect((await post(dana, { question: "q" })).json()).toEqual({
      status: "no_answer",
      reason: "uncited",
      note: null,
    });
    script = () => ({
      value: { answered: false, answer: "The code shown does not say.", citations: [] },
    });
    expect((await post(dana, { question: "q" })).json()).toEqual({
      status: "no_answer",
      reason: "model",
      note: "The code shown does not say.",
    });
  });

  it("sends the selection as context after the question", async () => {
    await indexRepository();
    const res = await post(dana, {
      question: "What does this do?",
      selection: { path: "web/a.tsx", startLine: 3, endLine: 4, text: "accept()" },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]!.labels.slice(0, 2)).toEqual(["question", "selection"]);
    expect(embedded[0]).toBe("What does this do?\nweb/a.tsx\naccept()");
  });

  it("checks the files at the indexed commit while a newer run is under way", async () => {
    await indexRepository();
    // A push queued a new run; the index still answers from COMMIT. GitHub's COMMIT holds a
    // different invite.ts than the index (as if the run had rewritten it part-way).
    await db.withOrg(A.orgId, (tx) => enqueueCodeIndex(tx, repoA, NEXT_COMMIT));
    github.putCode(FORGE_REPO, COMMIT, {
      "src/auth/invite.ts": `${INVITE}\n// changed`,
      "src/other.ts": OTHER,
    });
    script = (call) => {
      // Only other.ts is shown: invite.ts's blob is not the one at the indexed commit.
      expect(call.labels).toEqual(["question", "code"]);
      return answer([{ path: "src/other.ts", start: 2, end: 3 }]);
    };
    const from = github.requests.length;
    const res = await post(dana, { question: "q" });
    expect(res.json()).toMatchObject({ status: "answered", indexedSha: COMMIT });
    expect(githubCalls(from)).toContain(`GET repos/acme/rocky-app/git/trees/${COMMIT}`);
    const view = await get(dana);
    expect(view.json()).toEqual({ index: { status: "ready", indexedSha: COMMIT, updating: true } });
  });

  it("a push that starts a run while the question is embedded makes the search check the tree", async () => {
    await indexRepository();
    // Settled at COMMIT when the route reads the state; a push queues a run during the embed
    // call, before the search. GitHub's COMMIT holds another invite.ts than the index.
    onEmbed = async () => {
      await db.withOrg(A.orgId, (tx) => enqueueCodeIndex(tx, repoA, NEXT_COMMIT));
    };
    github.putCode(FORGE_REPO, COMMIT, {
      "src/auth/invite.ts": `${INVITE}\n// changed`,
      "src/other.ts": OTHER,
    });
    script = (call) => {
      expect(call.labels).toEqual(["question", "code"]);
      return answer([{ path: "src/other.ts", start: 2, end: 3 }]);
    };
    const from = github.requests.length;
    const res = await post(dana, { question: "q" });
    expect(res.json()).toMatchObject({ status: "answered", indexedSha: COMMIT });
    expect(githubCalls(from)).toContain(`GET repos/acme/rocky-app/git/trees/${COMMIT}`);
  });

  it("says no_context, without asking a model, when GitHub no longer has the indexed blobs", async () => {
    await indexRepository();
    // A GitHub that never held these blobs: each read is its 404.
    github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
    github.install(INSTALLATION, { id: 1_000_191, login: "acme", type: "Organization" });
    github.addRepository(INSTALLATION, {
      id: FORGE_REPO,
      fullName: "acme/rocky-app",
      private: true,
    });
    await app.close();
    app = build();
    await app.ready();
    expect((await post(dana, { question: "q" })).json()).toEqual({
      status: "no_answer",
      reason: "no_context",
      note: null,
    });
    expect(calls).toHaveLength(0);
    expect(github.tokens.revoked).toBe(1);
  });

  it("is 404, without asking a model, once the installation cannot read the repository", async () => {
    await indexRepository();
    github.removeRepository(FORGE_REPO);
    expect((await post(dana, { question: "q" })).json()).toEqual({ error: "not_found" });
    expect(calls).toHaveLength(0);
  });
});

describe("POST …/ask: refusals", () => {
  it("is 409 before the repository is indexed, and while a first index runs", async () => {
    expect((await post(dana, { question: "q" })).json()).toEqual({ error: "not_indexed" });
    await db.withOrg(A.orgId, (tx) => enqueueCodeIndex(tx, repoA, null));
    const res = await post(dana, { question: "q" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "indexing" });
    expect(embedded).toEqual([]);
    expect(github.tokens.mints).toEqual([]);
  });

  it("is 409 not_indexed for an index in another embedding space", async () => {
    await indexRepository({ ...SPACE, model: "text-embedding-3-large" });
    expect((await post(dana, { question: "q" })).json()).toEqual({ error: "not_indexed" });
  });

  it("refuses a body that is not a question, before anything is read", async () => {
    await indexRepository();
    for (const body of [
      {},
      { question: "" },
      { question: 3 },
      { question: "q", extra: 1 },
      { question: "q", selection: { path: "a", startLine: 2, endLine: 1, text: "x" } },
      { question: "q", selection: { path: "a", startLine: 1, endLine: 1, text: "x", more: 1 } },
      { question: "x".repeat(2001) },
    ]) {
      const res = await post(dana, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(res.json()).toEqual({ error: "invalid_question" });
    }
    expect(accessAsked).toEqual([]);
  });

  it("is 404 for another org's pull request, an unknown one, and a denied repository", async () => {
    await indexRepository();
    expect((await post(bo, { question: "q" })).statusCode).toBe(404);
    expect((await post(dana, { question: "q" }, ASK_URL(9))).statusCode).toBe(404);
    accessAnswer = { allowed: false, reason: "no_read_permission", cached: false };
    expect((await post(dana, { question: "q" })).json()).toEqual({ error: "not_found" });
    expect(embedded).toEqual([]);
  });

  it("is 503 when Ask is off (no embedding model)", async () => {
    await app.close();
    app = build({ withoutAsk: true });
    await app.ready();
    expect((await post(dana, { question: "q" })).json()).toEqual({ error: "ask_unavailable" });
    expect((await get(dana)).json()).toEqual({ index: { status: "off" } });
  });

  it("limits each member's questions per minute (ADR 0025 `ask`), saying so", async () => {
    await app.close();
    app = build({ askLimit: 1 });
    await app.ready();
    await indexRepository();
    expect((await post(dana, { question: "q" })).statusCode).toBe(200);
    const limited = await post(dana, { question: "q" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited", limit: "member" });
    expect(Number(limited.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(calls).toHaveLength(1);
    // Nothing was read or spent for the refused question: one embedding, one row set, one
    // access check.
    expect(embedded).toHaveLength(1);
    expect(accessAsked).toHaveLength(1);
    expect(await usageRows()).toHaveLength(2);
  });

  it("the org's budget is shared by its members, counted before anything is read, and holds under concurrency (P9-3)", async () => {
    await app.close();
    app = build({ askOrgLimit: 3 });
    await app.ready();
    await indexRepository();
    const { token: eve } = await sessionIn(A, 5103, "eve");
    // Eight questions at once from two members of A: exactly three reach the model, whatever
    // the interleaving, since `consume` counts and checks in one step.
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, i) => post(i % 2 === 0 ? dana : eve, { question: `q${i}` })),
    );
    const statuses = answers.map((a) => a.statusCode).sort();
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    for (const a of answers.filter((a) => a.statusCode === 429)) {
      expect(a.json()).toEqual({ error: "rate_limited", limit: "org" });
      expect(Number(a.headers["retry-after"])).toBeLessThanOrEqual(60);
    }
    expect(calls).toHaveLength(3);
    expect(embedded).toHaveLength(3);
    expect(accessAsked).toHaveLength(3);
    expect(await usageRows()).toHaveLength(6);
    // Another org's budget is its own: B is not limited by A's questions (B has no PR: 404).
    expect((await post(bo, { question: "q" })).statusCode).toBe(404);
    const outcomes = lines
      .map((l) => JSON.parse(l) as { ask_route?: { outcome: string } })
      .flatMap((l) => (l.ask_route === undefined ? [] : [l.ask_route.outcome]));
    expect(outcomes.filter((o) => o === "org_rate_limited")).toHaveLength(5);
    noContentInLogs();
  });

  it("the org's day budget is counted too, before the burst one would allow more", async () => {
    await app.close();
    app = build({ askOrgDayLimit: 1 });
    await app.ready();
    await indexRepository();
    expect((await post(dana, { question: "q" })).statusCode).toBe(200);
    const limited = await post(dana, { question: "q" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited", limit: "org" });
    const retryAfter = Number(limited.headers["retry-after"]);
    expect(retryAfter).toBeGreaterThan(60);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
    expect(calls).toHaveLength(1);
  });

  it("records a failed model call with its partial usage, and the embedding of a question GitHub failed (P9-3)", async () => {
    await indexRepository();
    script = () => ({
      error: new LlmCallError("network", {
        partialUsage: {
          inputTokens: 90,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheWrite5mInputTokens: 0,
          cacheWrite1hInputTokens: 0,
        },
      }),
    });
    expect((await post(dana, { question: "q" })).json()).toEqual({
      error: "model_unavailable",
      retryable: true,
    });
    expect((await usageRows()).map((r) => [r.role, r.outcome, r.usage_status, r.input_tokens])).toEqual([
      ["embed", "ok", "reported", 7],
      ["ask", "error", "partial", 90],
    ]);
    usageFrom = await lastUsageId();
    script = () => answer([{ path: "src/auth/invite.ts", start: 1, end: 1 }]);
    github.failRoute("blob", 502, 5);
    expect((await post(dana, { question: "q" })).json()).toEqual({ error: "forge_unavailable" });
    // The embedding was spent before GitHub failed: its row is there, and no model row follows.
    expect((await usageRows()).map((r) => [r.role, r.repo_id, r.pull_request_id])).toEqual([
      ["embed", repoA, pullA],
    ]);
  });

  it("a usage write that keeps failing fails the question closed: 503, and the model is never asked", async () => {
    await app.close();
    app = build({ recordUsage: () => Promise.reject(new Error(`down ${MARKER}`)) });
    await app.ready();
    await indexRepository();
    const res = await post(dana, { question: "q" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "ask_unavailable" });
    // The embedding was made (its write failed after); the ask call never was.
    expect(embedded).toHaveLength(1);
    expect(calls).toHaveLength(0);
    const outcomes = lines
      .map((l) => JSON.parse(l) as { ask_route?: { outcome: string }; errorCode?: string })
      .map((l) => l.ask_route?.outcome ?? l.errorCode);
    expect(outcomes).toContain("usage_unrecorded");
    expect(outcomes).toContain("llm_usage_unrecorded");
    noContentInLogs();
  });

  it("maps a model outage, a refused answer and a GitHub outage to 502, with fixed codes", async () => {
    await indexRepository();
    script = () => ({ error: new LlmCallError("overloaded") });
    expect((await post(dana, { question: "q" })).json()).toEqual({
      error: "model_unavailable",
      retryable: true,
    });
    script = () => ({ status: "refused" });
    expect((await post(dana, { question: "q" })).json()).toEqual({
      error: "answer_failed",
      reason: "refused",
    });
    script = () => answer([{ path: "src/auth/invite.ts", start: 1, end: 1 }]);
    github.failRoute("blob", 502, 5);
    const res = await post(dana, { question: "q" });
    expect(res.json()).toEqual({ error: "forge_unavailable" });
    expect(github.tokens.revoked).toBe(github.tokens.mints.length);
    noContentInLogs();
  });

  it("is 503 when the embedder answers in another width than the index", async () => {
    await indexRepository();
    embedVector = [1, 0, 0];
    expect((await post(dana, { question: "q" })).json()).toEqual({ error: "ask_unavailable" });
  });
});

describe("GET …/ask: where the index stands", () => {
  it("not indexed, indexing, ready", async () => {
    expect((await get(dana)).json()).toEqual({ index: { status: "not_indexed" } });
    await db.withOrg(A.orgId, (tx) => enqueueCodeIndex(tx, repoA, null));
    expect((await get(dana)).json()).toEqual({ index: { status: "indexing" } });
    await db.withOrg(A.orgId, (tx) =>
      tx.query("delete from code_indexes where org_id = $1", [A.orgId]),
    );
    await indexRepository();
    expect((await get(dana)).json()).toEqual({
      index: { status: "ready", indexedSha: COMMIT, updating: false },
    });
    expect((await get(bo)).statusCode).toBe(404);
    noContentInLogs();
  });
});

describe("askIndexView", () => {
  const state = (over: Partial<Parameters<typeof askIndexView>[0] & object> = {}) => ({
    indexId: "i",
    status: "done" as const,
    generation: 1,
    requestedSha: null,
    indexedSha: COMMIT,
    space: SPACE,
    errorCode: null,
    estimatedTokens: null,
    limitTokens: null,
    approvedTokens: null,
    filesIndexed: 1,
    chunksIndexed: 1,
    spentTokens: 1,
    completedAt: null,
    ...over,
  });

  it("maps each status and space to what Ask can do", () => {
    expect(askIndexView(null, undefined)).toEqual({ status: "off" });
    expect(askIndexView(null, SPACE)).toEqual({ status: "not_indexed" });
    expect(askIndexView(state(), SPACE)).toEqual({
      status: "ready",
      indexedSha: COMMIT,
      updating: false,
    });
    expect(askIndexView(state({ status: "running" }), SPACE)).toMatchObject({ updating: true });
    expect(askIndexView(state({ status: "failed" }), SPACE)).toMatchObject({ status: "ready" });
    expect(askIndexView(state({ status: "queued", indexedSha: null }), SPACE)).toEqual({
      status: "indexing",
    });
    expect(askIndexView(state({ status: "over_limit", indexedSha: null }), SPACE)).toEqual({
      status: "not_indexed",
    });
    expect(askIndexView(state({ space: { ...SPACE, dimensions: 8 } }), SPACE)).toEqual({
      status: "not_indexed",
    });
    expect(
      askIndexView(state({ status: "running", space: { ...SPACE, model: "m" } }), SPACE),
    ).toEqual({ status: "indexing" });
  });
});
