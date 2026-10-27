import { inspect } from "node:util";
import {
  ACCESS_MAX_TTL_MS,
  DENY_TTL_MS,
  type OrgId,
  type RepositoryAccessCheck,
  type RepositoryAccessRequest,
} from "@rocky-reviews/core";
import {
  decodeWrappedDataKey,
  encodeWrappedDataKey,
  generateLocalKek,
  generateWrappedDataKey,
  LocalKeyWrapper,
  OrgKeyring,
  type KeyWrapper,
} from "@rocky-reviews/crypto";
import {
  createDb,
  loadForgeToken,
  loadOrgDataKey,
  schema,
  storeForgeToken,
  storeOrgDataKey,
  type Db,
} from "@rocky-reviews/db";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  type TestPostgres,
} from "@rocky-reviews/db/testing";
import {
  createGitHubForge,
  createGitHubUserAccessReader,
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createRepositoryAccess,
  MEMBER_TOKEN_PURPOSE,
  memberAccessSource,
} from "./repository-access.js";

/**
 * P3-6 end to end (ADR 0011): the access check on a real Postgres as the application role
 * (RLS), the org keyring (envelope encryption, ADR 0006), and the fake GitHub serving
 * `GET /repos/{owner}/{repo}` for user tokens from the documentation-shaped fixture, with an
 * injected clock. Criterion: a user removed from the repository on GitHub loses access within
 * 5 minutes.
 */

const T0 = Date.parse("2026-10-27T10:00:00Z");
const GITHUB_USER = 1001; // seedOrg's member `alice`
const SHARED_REPO = 2001; // seedOrg's repository (every org gets one with this forge id)
const ORG_A_ONLY_REPO = 4001;
const ORG_B_REPO = 3001;

let pgs: TestPostgres;
let db: Db;
let keys: KeyWrapper;
let unwraps = 0;
const appKeys = testAppKeys();
const { api } = githubEndpoints({});
const appAuth = parseGitHubAppAuth({
  appId: String(FIXTURE_APP_ID),
  privateKey: appKeys.privateKeyPem,
});
/**
 * The user reader with the real membership check (installation tokens). The app JWT needs the
 * real clock: the fake checks it against `Date.now`.
 */
const readerFor = () =>
  createGitHubUserAccessReader({
    api,
    fetch: github.fetch,
    collaborators: createGitHubForge({
      auth: appAuth,
      api,
      clock: { now: () => new Date() },
      fetch: github.fetch,
    }),
  });
const lines: string[] = [];
const log = createLogger("access-test", {
  level: "debug",
  destination: { write: (line: string) => void lines.push(line) },
});

interface Org {
  orgId: OrgId;
  installationId: number;
  aliceId: string;
  bobId: string;
  aliceToken: string;
  fullName: string;
}
let A: Org;
let B: Org;
let github: FakeGitHubApi;
/** Every ciphertext written, for the hygiene checks. */
const ciphertexts: string[] = [];

const now = { ms: T0 };
const clock = { now: () => new Date(now.ms) };

const provision = async (installationId: number, extraRepo: number): Promise<Org> => {
  const orgId = newOrgId();
  const seeded = await asWorker(pgs.workerUrl, (w) => seedOrg(w, orgId, { installationId }));
  const fullName = `org-${installationId}/api`;
  const wrapped = await generateWrappedDataKey(keys, orgId);
  const aliceToken = github.addUser({ id: GITHUB_USER, login: "alice" });
  const bobId = await db.withOrg(orgId, async (tx) => {
    await storeOrgDataKey(tx, encodeWrappedDataKey(wrapped), wrapped.version);
    const keyring = await OrgKeyring.open(keys, orgId, [wrapped]);
    try {
      const ciphertext = keyring.encrypt(aliceToken, {
        purpose: MEMBER_TOKEN_PURPOSE,
        recordId: seeded.memberId,
      });
      ciphertexts.push(ciphertext);
      await storeForgeToken(tx, seeded.memberId, ciphertext, keyring.currentVersion);
    } finally {
      keyring.destroy();
    }
    await tx.db
      .insert(schema.repos)
      .values({ forgeRepoId: extraRepo, fullName: `org-${installationId}/extra` });
    const [bob] = await tx.db
      .insert(schema.members)
      .values({ forgeUserId: 1002, login: "bob" })
      .returning({ id: schema.members.id });
    return bob!.id;
  });
  github.install(installationId, {
    id: 9000 + installationId,
    login: `org-${installationId}`,
    type: "Organization",
  });
  return { orgId, installationId, aliceId: seeded.memberId, bobId, aliceToken, fullName };
};

beforeAll(async () => {
  pgs = await startPostgres();
  db = createDb({ connectionString: pgs.appUrl, max: 4 });
  const local = new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]);
  keys = {
    get currentKekVersion() {
      return local.currentKekVersion;
    },
    wrap: (key, context) => local.wrap(key, context),
    unwrap: (blob, version, context) => {
      unwraps++;
      return local.unwrap(blob, version, context);
    },
  };
  github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: appKeys.publicKey });
  A = await provision(51, ORG_A_ONLY_REPO);
  B = await provision(52, ORG_B_REPO);
  // GitHub knows org A's repository 2001 and B's 3001 (ids are global on GitHub).
  github.addRepository(A.installationId, { id: SHARED_REPO, fullName: A.fullName });
  github.addRepository(B.installationId, { id: ORG_B_REPO, fullName: "org-52/extra" });
  github.addRepository(A.installationId, { id: ORG_A_ONLY_REPO, fullName: "org-51/extra" });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await pgs?.stop();
});

let access: RepositoryAccessCheck;
beforeEach(() => {
  now.ms = T0;
  github.setPermission(GITHUB_USER, SHARED_REPO, "write");
  github.setPermission(GITHUB_USER, ORG_B_REPO, "read");
  github.setPermission(GITHUB_USER, ORG_A_ONLY_REPO, "read");
  access = createRepositoryAccess({
    db,
    keys,
    reader: readerFor(),
    clock,
    log,
  });
});

const asAlice = (org: Org, repositoryId = SHARED_REPO): RepositoryAccessRequest => ({
  orgId: org.orgId,
  memberId: org.aliceId,
  repositoryId,
});

describe("P3-6 criterion", () => {
  it("a user removed from the repository on GitHub loses access within 5 minutes", async () => {
    expect(await access.check(asAlice(A))).toEqual({
      allowed: true,
      cached: false,
      expiresAt: new Date(T0 + ACCESS_MAX_TTL_MS),
    });

    now.ms = T0 + 10_000;
    github.setPermission(GITHUB_USER, SHARED_REPO, null); // removed on GitHub

    now.ms = T0 + ACCESS_MAX_TTL_MS - 1;
    expect(await access.check(asAlice(A))).toMatchObject({ allowed: true, cached: true });

    now.ms = T0 + ACCESS_MAX_TTL_MS;
    expect(await access.check(asAlice(A))).toEqual({
      allowed: false,
      reason: "not_found",
      cached: false,
    });
    for (const later of [1, 29_999, 30_000, ACCESS_MAX_TTL_MS, 86_400_000]) {
      now.ms = T0 + ACCESS_MAX_TTL_MS + later;
      expect((await access.check(asAlice(A))).allowed).toBe(false);
    }
  });

  it("asks GitHub as the member, decrypting the token per question and never on a cache hit", async () => {
    const before = unwraps;
    const requests = github.requests.length;
    await access.check(asAlice(A));
    await access.check(asAlice(A));
    await access.check(asAlice(A));
    expect(unwraps - before).toBe(1);
    // A private repository: the identity call and one repository call, no collaborator call.
    expect(github.requests.slice(requests)).toEqual([
      { method: "GET", path: "/user", authorized: true },
      { method: "GET", path: `/repos/${A.fullName}`, authorized: true },
    ]);
  });
});

describe("Rocky membership and GitHub access are both required", () => {
  it("a member without a stored token is denied (no_token), without asking GitHub", async () => {
    const requests = github.requests.length;
    expect(
      await access.check({ orgId: A.orgId, memberId: A.bobId, repositoryId: SHARED_REPO }),
    ).toMatchObject({ allowed: false, reason: "no_token" });
    expect(github.requests.length).toBe(requests);
  });

  it("a GitHub reader who is not a member of the org is denied (not_member)", async () => {
    expect(
      await access.check({
        orgId: A.orgId,
        memberId: "5d1e9f00-cccc-4bcd-9e00-000000000003",
        repositoryId: SHARED_REPO,
      }),
    ).toMatchObject({ allowed: false, reason: "not_member" });
  });
});

describe("tenant separation", () => {
  it("org B's member id under org A is not a member there (RLS)", async () => {
    expect(
      await access.check({ orgId: A.orgId, memberId: B.aliceId, repositoryId: SHARED_REPO }),
    ).toMatchObject({ allowed: false, reason: "not_member" });
  });

  it("a repository of org A is unknown to org B, even for the same GitHub user", async () => {
    expect(await access.check(asAlice(A, ORG_A_ONLY_REPO))).toMatchObject({ allowed: true });
    expect(await access.check(asAlice(B, ORG_A_ONLY_REPO))).toMatchObject({
      allowed: false,
      reason: "unknown_repository",
    });
  });

  it("an allow cached for org A does not answer for org B, even for a name GitHub resolves", async () => {
    // Org C's row for the same forge id names A's repository, which GitHub resolves; C's own
    // token is revoked. Only a key that includes the org keeps A's allow away from C.
    const C = await provision(54, 5401);
    await db.withOrg(C.orgId, (tx) =>
      tx.query("update repos set full_name = $1 where forge_repo_id = $2", [
        A.fullName,
        SHARED_REPO,
      ]),
    );
    github.revokeUserToken(C.aliceToken);
    expect(await access.check(asAlice(A))).toMatchObject({ allowed: true, cached: false });
    const before = github.requests.length;
    expect(await access.check(asAlice(C))).toEqual({
      allowed: false,
      reason: "token_rejected",
      cached: false,
    });
    expect(github.requests.length).toBeGreaterThan(before);
    expect(await access.check(asAlice(A))).toMatchObject({ allowed: true, cached: true });
  });

  it("a ciphertext moved to another org's member row does not decrypt (other org key, AAD)", async () => {
    const stolen = await db.withOrg(A.orgId, (tx) => loadForgeToken(tx, A.aliceId));
    await db.withOrg(B.orgId, (tx) =>
      storeForgeToken(tx, B.bobId, stolen!.ciphertext, stolen!.keyVersion),
    );
    try {
      expect(
        await access.check({ orgId: B.orgId, memberId: B.bobId, repositoryId: ORG_B_REPO }),
      ).toMatchObject({ allowed: false, reason: "token_unreadable" });
    } finally {
      await db.withOrg(B.orgId, (tx) =>
        tx.query(
          "update members set forge_token_ciphertext = null, forge_token_key_version = null where id = $1",
          [B.bobId],
        ),
      );
    }
  });

  it("a token copied to another member's row does not decrypt (AAD binds the member)", async () => {
    const stolen = await db.withOrg(A.orgId, (tx) => loadForgeToken(tx, A.aliceId));
    await db.withOrg(A.orgId, (tx) =>
      storeForgeToken(tx, A.bobId, stolen!.ciphertext, stolen!.keyVersion),
    );
    try {
      expect(
        await access.check({ orgId: A.orgId, memberId: A.bobId, repositoryId: SHARED_REPO }),
      ).toMatchObject({ allowed: false, reason: "token_unreadable" });
    } finally {
      await db.withOrg(A.orgId, (tx) =>
        tx.query(
          "update members set forge_token_ciphertext = null, forge_token_key_version = null where id = $1",
          [A.bobId],
        ),
      );
    }
  });
});

describe("fail closed", () => {
  it("a revoked token is denied (token_rejected)", async () => {
    // Its own org, so revoking this token does not affect the other tests.
    const org = await provision(53, 5001);
    github.addRepository(org.installationId, { id: 5001, fullName: "org-53/extra" });
    github.setPermission(GITHUB_USER, 5001, "read");
    expect((await access.check(asAlice(org, 5001))).allowed).toBe(true);
    github.revokeUserToken(org.aliceToken);
    access.invalidateMember(org.orgId, org.aliceId);
    expect(await access.check(asAlice(org, 5001))).toMatchObject({
      allowed: false,
      reason: "token_rejected",
    });
  });

  it("a GitHub outage is a deny, never an allow", async () => {
    github.failRoute("repository", 503);
    expect(await access.check(asAlice(A))).toMatchObject({
      allowed: false,
      reason: "forge_unavailable",
    });
  });

  it("SSO enforcement or rate limiting (403) is a deny", async () => {
    github.failRoute("repository", 403);
    expect(await access.check(asAlice(A))).toMatchObject({ allowed: false, reason: "forbidden" });
  });

  it("the wrong key-encryption key is a deny (token_unreadable)", async () => {
    const other = new LocalKeyWrapper([["v1", Buffer.from(generateLocalKek(), "base64")]]);
    const wrong = createRepositoryAccess({
      db,
      keys: other,
      reader: readerFor(),
      clock,
      log,
    });
    expect(await wrong.check(asAlice(A))).toMatchObject({
      allowed: false,
      reason: "token_unreadable",
    });
  });

  it("an org without a data key is a deny (token_unreadable)", async () => {
    const source = memberAccessSource({
      db: {
        ...db,
        withOrg: async () => ({
          member: true,
          repositoryFullName: A.fullName,
          token: { ciphertext: ciphertexts[0]!, keyVersion: 1 },
          dataKey: null,
        }),
      } as unknown as Db,
      keys,
      reader: readerFor(),
    });
    expect(await source.readAccess(asAlice(A))).toEqual({
      access: "none",
      reason: "token_unreadable",
    });
  });

  it("an org without a stored installation is a deny (no_installation), before any decryption", async () => {
    const before = unwraps;
    const source = memberAccessSource({
      db: {
        ...db,
        withOrg: async () => ({
          member: true,
          forgeUserId: GITHUB_USER,
          installationId: null,
          repositoryFullName: A.fullName,
          token: { ciphertext: ciphertexts[0]!, keyVersion: 1 },
          dataKey: { ciphertext: "rkw1:unused", keyVersion: 1 },
        }),
      } as unknown as Db,
      keys,
      reader: readerFor(),
    });
    expect(await source.readAccess(asAlice(A))).toEqual({
      access: "none",
      reason: "no_installation",
    });
    expect(unwraps).toBe(before);
  });

  it("a database failure is a deny, and its text is never logged", async () => {
    const before = lines.length;
    const broken = createRepositoryAccess({
      db: {
        ...db,
        withOrg: () => Promise.reject(new Error(`connection lost ${A.aliceToken}`)),
      } as unknown as Db,
      keys,
      reader: readerFor(),
      clock,
      log,
    });
    expect(await broken.check(asAlice(A))).toMatchObject({ allowed: false, reason: "error" });
    expect(lines.slice(before).join("\n")).not.toContain("connection lost");
  });

  it("a stored data key that does not decode is a deny", async () => {
    const source = memberAccessSource({
      db: {
        ...db,
        withOrg: async () => ({
          member: true,
          repositoryFullName: A.fullName,
          token: { ciphertext: ciphertexts[0]!, keyVersion: 1 },
          dataKey: { ciphertext: "rkw1:broken", keyVersion: 1 },
        }),
      } as unknown as Db,
      keys,
      reader: readerFor(),
    });
    expect(await source.readAccess(asAlice(A))).toMatchObject({ reason: "token_unreadable" });
  });
});

/** Encrypts `token` under the org's own key for `memberId` and stores it on that row. */
const storeToken = async (org: Org, memberId: string, token: string): Promise<void> => {
  await db.withOrg(org.orgId, async (tx) => {
    const dataKey = await loadOrgDataKey(tx);
    const keyring = await OrgKeyring.open(keys, org.orgId, [
      decodeWrappedDataKey(dataKey!.ciphertext),
    ]);
    try {
      const ciphertext = keyring.encrypt(token, {
        purpose: MEMBER_TOKEN_PURPOSE,
        recordId: memberId,
      });
      ciphertexts.push(ciphertext);
      await storeForgeToken(tx, memberId, ciphertext, keyring.currentVersion);
    } finally {
      keyring.destroy();
    }
  });
};

describe("review round 1, B: the token is bound to the member's GitHub identity", () => {
  it("a valid token of another GitHub user stored on the member's row is denied", async () => {
    const org = await provision(55, 5501);
    github.addRepository(org.installationId, { id: 5501, fullName: "org-55/extra" });
    const other = github.addUser({ id: 7777, login: "someone-else" });
    github.setPermission(7777, 5501, "admin");
    github.setPermission(GITHUB_USER, 5501, "read");
    await storeToken(org, org.aliceId, other);
    expect(await access.check(asAlice(org, 5501))).toEqual({
      allowed: false,
      reason: "token_user_mismatch",
      cached: false,
    });
    expect(access.entries()[0]?.expiresAt).toEqual(new Date(T0 + DENY_TTL_MS));
  });
});

describe("review round 1, A: public and internal repositories require collaborator status", () => {
  for (const visibility of ["public", "internal"] as const) {
    it(`${visibility}: a removed collaborator loses access within exactly 5 minutes`, async () => {
      github.setVisibility(SHARED_REPO, visibility);
      try {
        expect(await access.check(asAlice(A))).toEqual({
          allowed: true,
          cached: false,
          expiresAt: new Date(T0 + ACCESS_MAX_TTL_MS),
        });
        now.ms = T0 + 10_000;
        // Removed as a collaborator; GitHub still answers `pull: true` (everyone can read it).
        github.setPermission(GITHUB_USER, SHARED_REPO, null);
        now.ms = T0 + ACCESS_MAX_TTL_MS - 1;
        expect(await access.check(asAlice(A))).toMatchObject({ allowed: true, cached: true });
        now.ms = T0 + ACCESS_MAX_TTL_MS;
        expect(await access.check(asAlice(A))).toEqual({
          allowed: false,
          reason: "not_collaborator",
          cached: false,
        });
        for (const later of [1, 29_999, 30_000, ACCESS_MAX_TTL_MS, 86_400_000]) {
          now.ms = T0 + ACCESS_MAX_TTL_MS + later;
          expect((await access.check(asAlice(A))).allowed).toBe(false);
        }
      } finally {
        github.setVisibility(SHARED_REPO, "private");
      }
    });

    it(`${visibility}: a non-collaborator is denied although GitHub says pull: true`, async () => {
      github.setVisibility(SHARED_REPO, visibility);
      github.setPermission(GITHUB_USER, SHARED_REPO, null);
      try {
        const before = github.requests.length;
        expect(await access.check(asAlice(A))).toMatchObject({
          allowed: false,
          reason: "not_collaborator",
        });
        const calls = github.requests.slice(before).map((r) => `${r.method} ${r.path}`);
        // B1: GitHub's effective-role endpoint says `read` for this non-collaborator …
        const effective = await github.fetch(
          `https://api.github.com/repos/${A.fullName}/collaborators/alice/permission`,
          { headers: { authorization: `Bearer ${A.aliceToken}` }, redirect: "error" },
        );
        expect(((await effective.json()) as { permission: string }).permission).toBe("read");
        // … so membership is asked on an installation token instead, which says no.
        expect(calls).toEqual([
          "GET /user",
          `GET /repos/${A.fullName}`,
          `POST /app/installations/${A.installationId}/access_tokens`,
          `GET /repos/${A.fullName}/collaborators/alice`,
          "DELETE /installation/token",
        ]);
      } finally {
        github.setVisibility(SHARED_REPO, "private");
      }
    });
  }

  it("every error of the membership check denies", async () => {
    github.setVisibility(SHARED_REPO, "public");
    try {
      for (const status of [500, 502, 429, 403, 401]) {
        const fresh = createRepositoryAccess({
          db,
          keys,
          reader: readerFor(),
          clock,
          log,
        });
        github.failRoute("membership", status);
        expect((await fresh.check(asAlice(A))).allowed).toBe(false);
      }
    } finally {
      github.setVisibility(SHARED_REPO, "private");
    }
  });
});

describe("hygiene: tokens never in logs, errors or the cache", () => {
  it("logs carry ids and fixed codes only; no token or ciphertext anywhere", async () => {
    const errors: unknown[] = [];
    await access.check(asAlice(A));
    await access.check(asAlice(A));
    github.failRoute("repository", 500);
    await access.check(asAlice(B, ORG_B_REPO));
    // Review round 3, S1: public repositories go through the installation-token membership
    // check, once successfully and once with a forced membership failure.
    github.setVisibility(SHARED_REPO, "public");
    try {
      access.invalidateMember(A.orgId, A.aliceId); // drop the private-repository allow
      const issuedBefore = github.tokens.issued.length;
      expect(await access.check(asAlice(A))).toMatchObject({ allowed: true, cached: false });
      access.invalidateMember(A.orgId, A.aliceId);
      github.failRoute("membership", 500);
      expect(await access.check(asAlice(A))).toMatchObject({
        allowed: false,
        reason: "forge_unavailable",
      });
      expect(github.tokens.issued.length).toBe(issuedBefore + 2);
      // The errors themselves, as the reader and the forge throw them.
      const reader = readerFor();
      for (const route of ["membership", "token", "repository", "user"] as const) {
        github.failRoute(route, 500);
        errors.push(
          await reader
            .readUserRepositoryAccess(
              { token: A.aliceToken, userId: GITHUB_USER },
              { installationId: A.installationId, id: SHARED_REPO, fullName: A.fullName },
            )
            .catch((e: unknown) => e),
        );
      }
    } finally {
      github.setVisibility(SHARED_REPO, "private");
    }
    expect(errors.every((e) => e instanceof Error)).toBe(true);
    expect(github.tokens.issued.length).toBeGreaterThan(0);

    const all = lines.join("\n");
    const secrets = [...github.userTokens, ...github.tokens.issued];
    for (const token of secrets) expect(all).not.toContain(token);
    for (const ciphertext of ciphertexts) expect(all).not.toContain(ciphertext.slice(4, 40));
    expect(all).not.toContain("Bearer");

    const events = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((l) => l["event"] === "repository_access");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      const { level, time, pid, hostname, name, msg, ...rest } = e;
      void [level, time, pid, hostname, name];
      expect(msg).toBe("repository access");
      expect(Object.keys(rest).sort()).toEqual(
        [
          "allowed",
          "cached",
          "event",
          "joined",
          "memberId",
          "orgId",
          "reason",
          "repositoryId",
        ].sort(),
      );
    }

    const cache =
      JSON.stringify(access.entries()) + inspect(access, { depth: 10, showHidden: true });
    const thrown = errors.map((e) => inspect(e, { depth: 10, showHidden: true })).join("\n");
    for (const token of secrets) {
      expect(cache).not.toContain(token);
      expect(thrown).not.toContain(token);
    }
  });
});
