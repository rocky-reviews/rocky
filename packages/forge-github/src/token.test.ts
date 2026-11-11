import { ForgeReadError } from "@rocky-reviews/core";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubEndpoints } from "./app-manifest.js";
import { fakeGitHubApi, FIXTURE_APP_ID, testAppKeys, type FakeGitHubApi } from "./testing.js";
import { createGitHubTokenClient, MAX_LISTED_REPOSITORIES } from "./token.js";

/**
 * P10-4 (ADR 0045): GitHub on a personal access token, against the fake GitHub. The token is
 * accepted only in GitHub's two personal shapes, identified by `GET /user`, never revoked by
 * Rocky, and never appears in a request log line, an error or an answer.
 */

const keys = testAppKeys();
const { api } = githubEndpoints({});
const OWNER = { id: 7001, login: "solo-dev" };
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
/** Assembled at runtime: no token-shaped literal in the source. */
const FINE = ["github", "pat", `${"11AAAAAA".repeat(3)}_${randomBytes(30).toString("hex")}`].join(
  "_",
);
const CLASSIC = `ghp_${randomBytes(18).toString("hex")}`;

const setup = (now = () => new Date("2026-11-11T10:00:00Z")) => {
  const github = fakeGitHubApi({
    appId: FIXTURE_APP_ID,
    publicKey: keys.publicKey,
    now: () => now().getTime(),
  });
  github.install(4242, { id: 9001, login: "acme", type: "Organization" });
  github.addRepository(4242, { id: 77, fullName: "acme/api" });
  github.addRepository(4242, { id: 78, fullName: "acme/web" });
  github.addRepository(4242, { id: 79, fullName: "acme/secret" });
  github.setPermission(OWNER.id, 77, "write");
  github.setPermission(OWNER.id, 78, "read");
  github.putPullRequest(77, { number: 847, headSha: HEAD });
  github.putPullRequest(77, { number: 848, headSha: HEAD, state: "closed" });
  const client = createGitHubTokenClient({ api, fetch: github.fetch });
  return { github, client };
};

const failure = async (promise: Promise<unknown>): Promise<ForgeReadError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ForgeReadError) return error;
    throw error;
  }
  throw new Error("expected a ForgeReadError");
};

const noTokenIn = (github: FakeGitHubApi, token: string) => {
  expect(JSON.stringify(github.requests)).not.toContain(token);
};

describe("readUser", () => {
  it("identifies a fine-grained token: the owner's id and login, its expiry, no scopes", async () => {
    const { github, client } = setup();
    github.addUser(OWNER, { token: FINE, tokenExpiresAt: "2027-01-01 00:00:00 UTC" });
    const read = await client.readUser(FINE);
    expect(read).toEqual({
      ok: true,
      value: {
        id: OWNER.id,
        login: OWNER.login,
        kind: "fine_grained",
        expiresAt: new Date("2027-01-01T00:00:00Z"),
        scopes: [],
      },
    });
    expect(github.requests).toEqual([{ method: "GET", path: "/user", authorized: true }]);
    noTokenIn(github, FINE);
  });

  it("identifies a classic token with its scopes and no expiry", async () => {
    const { client, github } = setup();
    github.addUser(OWNER, { token: CLASSIC, scopes: "repo, read:org" });
    const read = await client.readUser(CLASSIC);
    expect(read).toEqual({
      ok: true,
      value: {
        id: OWNER.id,
        login: OWNER.login,
        kind: "classic",
        expiresAt: null,
        scopes: ["repo", "read:org"],
      },
    });
    // An unreadable expiry header is "unknown", never a crash or a wrong date.
    github.addUser(
      { id: 2, login: "two" },
      { token: `ghp_${"z".repeat(36)}`, tokenExpiresAt: "soon" },
    );
    const odd = await client.readUser(`ghp_${"z".repeat(36)}`);
    expect(odd.ok && odd.value.expiresAt).toBeNull();
  });

  it("refuses anything but a personal token before any request", async () => {
    const { github, client } = setup();
    for (const other of [`gho_${"x".repeat(36)}`, `ghs_${"x".repeat(36)}`, "hunter2", ""]) {
      expect(await client.readUser(other)).toEqual({ ok: false, reason: "not_a_personal_token" });
      expect(await client.listRepositories(other)).toEqual({
        ok: false,
        reason: "not_a_personal_token",
      });
      expect(await client.getRepository(other, 77)).toEqual({
        ok: false,
        reason: "not_a_personal_token",
      });
    }
    expect(github.requests).toEqual([]);
  });

  it("maps GitHub's refusals to fixed reasons: 401 rejected, 403 forbidden", async () => {
    const { github, client } = setup();
    github.addUser(OWNER, { token: FINE });
    github.revokeUserToken(FINE);
    expect(await client.readUser(FINE)).toEqual({ ok: false, reason: "token_rejected" });
    const other = setup();
    other.github.addUser(OWNER, { token: FINE });
    other.github.failRoute("user", 403);
    expect(await other.client.readUser(FINE)).toEqual({ ok: false, reason: "forbidden" });
    other.github.failRoute("user", 500);
    const error = await failure(other.client.readUser(FINE));
    expect(error.reason).toBe("http_status");
    expect(error.message).not.toContain(FINE);
  });

  it("an exhausted rate limit is rate_limited with GitHub's reset time (never a plain 403)", async () => {
    const { github, client } = setup();
    github.addUser(OWNER, { token: FINE });
    const reset = Date.parse("2026-11-11T10:30:00Z");
    github.exhaustRateLimit(reset);
    const error = await failure(client.readUser(FINE));
    expect(error.reason).toBe("rate_limited");
    expect(error.transient).toBe(true);
    expect(error.retryAt).toEqual(new Date(reset));
    github.restoreRateLimit();
    expect((await client.readUser(FINE)).ok).toBe(true);
  });
});

describe("repositories on the token", () => {
  it("lists what the token's owner has a role on, with their permissions, newest first", async () => {
    const { client, github } = setup();
    github.addUser(OWNER, { token: FINE });
    const listed = await client.listRepositories(FINE);
    expect(listed).toEqual({
      ok: true,
      value: {
        truncated: false,
        repositories: [
          {
            id: 78,
            fullName: "acme/web",
            private: true,
            defaultBranch: "main",
            permissions: { pull: true, push: false },
          },
          {
            id: 77,
            fullName: "acme/api",
            private: true,
            defaultBranch: "main",
            permissions: { pull: true, push: true },
          },
        ],
      },
    });
    noTokenIn(github, FINE);
  });

  it("pages and stops at the bound, saying so", async () => {
    const { client, github } = setup();
    github.addUser(OWNER, { token: FINE });
    for (let i = 0; i < 250; i++) {
      github.addRepository(4242, { id: 1000 + i, fullName: `acme/r${i}` });
      github.setPermission(OWNER.id, 1000 + i, "read");
    }
    const all = await client.listRepositories(FINE);
    expect(all.ok && all.value.repositories.length).toBe(252);
    expect(all.ok && all.value.truncated).toBe(false);
    const some = await client.listRepositories(FINE, { max: 120 });
    expect(some.ok && some.value.repositories.length).toBe(120);
    expect(some.ok && some.value.truncated).toBe(true);
    await expect(client.listRepositories(FINE, { max: 0 })).rejects.toThrow(/invalid max/);
    await expect(
      client.listRepositories(FINE, { max: MAX_LISTED_REPOSITORIES + 1 }),
    ).rejects.toThrow(/invalid max/);
  });

  it("reads one repository by id, and sees nothing the token cannot see", async () => {
    const { client, github } = setup();
    github.addUser(OWNER, { token: FINE });
    const found = await client.getRepository(FINE, 77);
    expect(found).toEqual({
      ok: true,
      value: {
        id: 77,
        fullName: "acme/api",
        private: true,
        defaultBranch: "main",
        permissions: { pull: true, push: true },
      },
    });
    // No role and private: GitHub's 404, not "forbidden".
    expect(await client.getRepository(FINE, 79)).toEqual({ ok: true, value: null });
    expect(await client.getRepository(FINE, 4_000_000)).toEqual({ ok: true, value: null });
    await expect(client.getRepository(FINE, 0)).rejects.toThrow(/invalid id/);
  });

  it("opens a session with the same reads as an installation session, revoking nothing", async () => {
    const { client, github } = setup();
    github.addUser(OWNER, { token: FINE });
    github.putDiff(77, { baseSha: BASE, headSha: HEAD }, "diff --git a/x b/x\n+1\n");
    const opened = await client.openRepository(FINE, 77);
    if (!opened.ok || opened.value === null) throw new Error("expected a session");
    const session = opened.value;
    expect(session.repository.fullName).toBe("acme/api");
    const pr = await session.getPullRequest(847);
    expect(pr).toMatchObject({
      ref: { installationId: null, repositoryId: 77, number: 847 },
      headSha: HEAD,
      state: "open",
    });
    expect(await session.getPullRequest(999)).toBeNull();
    const numbers: number[] = [];
    for await (const summary of session.listPullRequests()) numbers.push(summary.number);
    expect(numbers.sort()).toEqual([847, 848]);
    const diff = await session.getDiff({ baseSha: BASE, headSha: HEAD }, { maxBytes: 1024 });
    expect(new TextDecoder().decode(diff.bytes)).toContain("+1");
    await session.close();
    await session.close();
    // The token is the person's: nothing was minted, nothing revoked, nothing logged.
    expect(github.tokens.mints).toEqual([]);
    expect(github.tokens.revoked).toBe(0);
    expect(github.requests.some((r) => r.path.includes("installation/token"))).toBe(false);
    noTokenIn(github, FINE);
    await expect(session.getPullRequest(847)).rejects.toThrow(/closed/);
    // A repository the token cannot see: no session.
    expect(await client.openRepository(FINE, 79)).toEqual({ ok: true, value: null });
    expect(await client.openRepository(`gho_${"x".repeat(36)}`, 77)).toEqual({
      ok: false,
      reason: "not_a_personal_token",
    });
  });

  it("a rejected token in a session surfaces as a 401 read failure, without the token", async () => {
    const { client, github } = setup();
    github.addUser(OWNER, { token: FINE });
    const opened = await client.openRepository(FINE, 77);
    if (!opened.ok || opened.value === null) throw new Error("expected a session");
    github.revokeUserToken(FINE);
    const error = await failure(opened.value.getPullRequest(847));
    expect(error.reason).toBe("http_status");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(FINE);
  });

  it("never sends the token anywhere but the configured API", async () => {
    const seen: string[] = [];
    const client = createGitHubTokenClient({
      api,
      fetch: (input, init) => {
        seen.push(String(input));
        void init;
        return Promise.reject(new TypeError("fetch failed"));
      },
    });
    const error = await failure(client.readUser(FINE));
    expect(error.reason).toBe("network");
    expect(seen).toEqual(["https://api.github.com/user"]);
    expect(JSON.stringify(seen)).not.toContain(FINE);
  });
});
