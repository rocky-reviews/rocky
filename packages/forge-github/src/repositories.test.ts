import { createHash } from "node:crypto";
import { ForgeReadError, type RepositorySession } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { parseGitHubAppAuth } from "./app-auth.js";
import { githubEndpoints } from "./app-manifest.js";
import {
  createGitHubForge,
  LIST_PAGE_SIZE,
  MIRROR_TOKEN_PERMISSIONS,
  TOKEN_REFRESH_MARGIN_MS,
} from "./repositories.js";
import {
  fakeGitHubApi,
  FIXTURE_APP_ID,
  githubFixture,
  testAppKeys,
  type FakeGitHubApi,
} from "./testing.js";

/**
 * P3-4: repository sessions on installation tokens (ADR 0010). Served by `fakeGitHubApi` from the
 * documentation-shaped fixtures in `packages/forge-github/fixtures/` (GitHub's documented response
 * shapes with synthetic ids, not recorded from GitHub).
 */

const keys = testAppKeys();
const auth = parseGitHubAppAuth({ appId: String(FIXTURE_APP_ID), privateKey: keys.privateKeyPem });
const { api } = githubEndpoints({});
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const REF = { installationId: 4242, repositoryId: 77 };

const setup = (now: () => Date = () => new Date()) => {
  const github = fakeGitHubApi({
    appId: FIXTURE_APP_ID,
    publicKey: keys.publicKey,
    now: () => now().getTime(),
  });
  github.install(4242, { id: 9001, login: "acme", type: "Organization" });
  github.addRepository(4242, { id: 77, fullName: "acme/api" });
  github.addRepository(4242, { id: 78, fullName: "acme/web" });
  github.putPullRequest(77, { number: 847, headSha: HEAD });
  const forge = createGitHubForge({ auth, api, clock: { now }, fetch: github.fetch });
  return { github, forge };
};

const open = async (forge: ReturnType<typeof createGitHubForge>): Promise<RepositorySession> => {
  const session = await forge.openRepository(REF);
  if (session === null) throw new Error("expected a session");
  return session;
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

/** A fetch that answers the token mint with `body` and records every request. */
const mintAnswering = (status: number, body: unknown) => {
  const seen: { method: string; path: string }[] = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    seen.push({ method: init?.method ?? "GET", path: url.pathname });
    return Promise.resolve(
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
    );
  };
  return { fetch: fetchImpl as typeof fetch, seen };
};

const forgeWith = (fetchImpl: typeof fetch) =>
  createGitHubForge({ auth, api, clock: { now: () => new Date() }, fetch: fetchImpl });

describe("installation tokens: short-lived, scoped to one repository, read-only", () => {
  it("mints a token for exactly the repository asked for, with read permissions only", async () => {
    const { github, forge } = setup();
    const session = await open(forge);
    expect(session.repository).toEqual({
      id: 77,
      fullName: "acme/api",
      private: true,
      defaultBranch: "main",
    });
    expect(github.tokens.mints).toEqual([
      {
        installationId: 4242,
        body: { repository_ids: [77], permissions: { contents: "read", pull_requests: "read" } },
      },
    ]);
    expect(MIRROR_TOKEN_PERMISSIONS).toEqual({ contents: "read", pull_requests: "read" });
    // The mint is authenticated as the app; reads with the token.
    await session.getPullRequest(847);
    expect(github.requests.map((r) => [r.method, r.path, r.authorized])).toEqual([
      ["POST", "/app/installations/4242/access_tokens", true],
      ["GET", "/repos/acme/api/pulls/847", true],
    ]);
    await session.close();
  });

  it("revokes the token on close; close is idempotent and the session refuses further reads", async () => {
    const { github, forge } = setup();
    const session = await open(forge);
    await session.close();
    await session.close();
    expect(github.tokens.revoked).toBe(1);
    expect(github.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/installation/token" });
    await expect(session.getPullRequest(847)).rejects.toThrow(/closed/);
  });

  it("a token for one repository cannot read another (GitHub answers 404)", async () => {
    const { github, forge } = setup();
    github.putPullRequest(78, { number: 1, headSha: HEAD });
    const session = await open(forge);
    // Same token, another repository's path: the fake (like GitHub) does not let it through.
    const token = github.tokens.issued[0]!;
    const response = await github.fetch("https://api.github.com/repos/acme/web/pulls/1", {
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
    });
    expect(response.status).toBe(404);
    await session.close();
  });

  it("is null when GitHub says the installation is gone or cannot access the repository", async () => {
    const { github, forge } = setup();
    expect(await forge.openRepository({ installationId: 4242, repositoryId: 999 })).toBeNull();
    github.uninstall(4242);
    expect(await forge.openRepository(REF)).toBeNull();
    expect(github.tokens.issued).toEqual([]);
  });

  it("treats a suspended installation's 403 as a (transient) read failure, never as gone", async () => {
    const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
    github.install(4242, { id: 9001, login: "acme", type: "Organization" }, { suspended: true });
    github.addRepository(4242, { id: 77, fullName: "acme/api" });
    const forge = createGitHubForge({
      auth,
      api,
      clock: { now: () => new Date() },
      fetch: github.fetch,
    });
    const error = await failure(forge.openRepository(REF));
    expect(error.code).toBe("forge_http_403");
    expect(error.transient).toBe(true);
  });

  it("refuses and revokes a token whose permissions exceed the ask", async () => {
    const body = {
      ...githubFixture("post-installation-access-token"),
      permissions: { contents: "read", pull_requests: "write", metadata: "read" },
    };
    const { fetch: f, seen } = mintAnswering(201, body);
    expect((await failure(forgeWith(f).openRepository(REF))).code).toBe("forge_invalid_response");
    expect(seen.at(-1)).toEqual({ method: "DELETE", path: "/installation/token" });
  });

  it("refuses and revokes a token for another repository, or for more than one", async () => {
    const fixture = githubFixture("post-installation-access-token");
    const repo = (fixture["repositories"] as Record<string, unknown>[])[0]!;
    for (const repositories of [[{ ...repo, id: 78 }], [repo, { ...repo, id: 78 }], []]) {
      const { fetch: f, seen } = mintAnswering(201, { ...fixture, repositories });
      expect((await failure(forgeWith(f).openRepository(REF))).code).toBe("forge_invalid_response");
      expect(seen.at(-1)).toEqual({ method: "DELETE", path: "/installation/token" });
    }
  });

  it("N1: a 201 whose token fails validation is still revoked when a header-safe token can be read", async () => {
    const fixture = githubFixture("post-installation-access-token");
    /** A fetch answering the mint with a raw body, recording each request's authorization. */
    const raw = (body: string, type = "application/json") => {
      const seen: { method: string; authorization: string | null }[] = [];
      const f = ((_: string, init?: RequestInit) => {
        seen.push({
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Promise.resolve(
          init?.method === "DELETE"
            ? new Response(null, { status: 204 })
            : new Response(body, { status: 201, headers: { "content-type": type } }),
        );
      }) as unknown as typeof fetch;
      return { f, seen };
    };
    // Extractable and header-safe, but not a valid token (too short): revoked, then refused.
    for (const token of ["short", "x".repeat(600)]) {
      const { f, seen } = raw(JSON.stringify({ ...fixture, token }));
      for (const call of [
        () => forgeWith(f).openRepository(REF),
        () => forgeWith(f).isCollaborator(REF, "octo-dev"),
      ]) {
        seen.length = 0;
        expect((await failure(call())).code).toBe("forge_invalid_response");
        expect(seen.map((x) => x.method)).toEqual(["POST", "DELETE"]);
        expect(seen[1]?.authorization).toBe(`Bearer ${token}`);
      }
    }
    // Nothing usable can be extracted: no revocation request is made (and no header is built
    // from it). Such a token, if GitHub issued one, expires on its own within the hour.
    const unusable = [
      raw(JSON.stringify({ ...fixture, token: "has space in it 0123456789" })),
      raw(JSON.stringify({ ...fixture, token: "line\r\nx-injected: 1-0123456789" })),
      raw(JSON.stringify({ ...fixture, token: 12345 })),
      raw(JSON.stringify({ ...fixture, token: undefined })),
      raw("{not json"),
      raw("<html>", "text/html"),
    ];
    for (const { f, seen } of unusable) {
      expect((await failure(forgeWith(f).openRepository(REF))).code).toBe("forge_invalid_response");
      expect(seen.map((x) => x.method)).toEqual(["POST"]);
    }
  });

  it("refuses malformed or unexpected mint answers without leaking the token", async () => {
    const fixture = githubFixture("post-installation-access-token");
    const cases: [number, unknown, string][] = [
      [201, { ...fixture, token: "short" }, "forge_invalid_response"],
      [201, { ...fixture, expires_at: "never" }, "forge_invalid_response"],
      [200, fixture, "forge_http_200"],
      [500, { message: "boom" }, "forge_http_500"],
      [404, { message: "Something else" }, "forge_invalid_response"],
    ];
    for (const [status, body, code] of cases) {
      const error = await failure(forgeWith(mintAnswering(status, body).fetch).openRepository(REF));
      expect(error.code, `${status}`).toBe(code);
      expect(error.message).not.toContain("test-only-installation-token");
    }
    const html = (() =>
      Promise.resolve(
        new Response("<html>422</html>", { status: 422, headers: { "content-type": "text/html" } }),
      )) as unknown as typeof fetch;
    expect((await failure(forgeWith(html).openRepository(REF))).code).toBe(
      "forge_invalid_response",
    );
  });

  it("replaces a token about to expire before the next read and revokes the old one", async () => {
    let now = Date.now();
    const { github, forge } = setup(() => new Date(now));
    const session = await open(forge);
    await session.getPullRequest(847);
    now += 3_600_000 - TOKEN_REFRESH_MARGIN_MS + 1_000;
    await session.getPullRequest(847);
    expect(github.tokens.issued).toHaveLength(2);
    expect(github.tokens.revoked).toBe(1);
    await session.close();
    expect(github.tokens.revoked).toBe(2);
  });

  it("fails a read when access was lost by the time the token needed replacing", async () => {
    let now = Date.now();
    const { github, forge } = setup(() => new Date(now));
    const session = await open(forge);
    github.removeRepository(77);
    now += 3_600_000;
    expect((await failure(session.getPullRequest(847))).code).toBe("forge_http_404");
  });

  it("refuses ids, names and API bases it cannot use", async () => {
    const { forge } = setup();
    await expect(forge.openRepository({ installationId: 0, repositoryId: 77 })).rejects.toThrow();
    await expect(forge.locateRepository("acme/../x/y")).rejects.toThrow();
    expect(() =>
      createGitHubForge({
        auth,
        api: new URL("http://api.example.com/"),
        clock: { now: () => new Date() },
      }),
    ).toThrow(/https/);
  });

  it("maps a timeout and a network failure to fixed reasons", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
        );
      })) as unknown as typeof fetch;
    const slow = createGitHubForge({
      auth,
      api,
      clock: { now: () => new Date() },
      fetch: hang,
      timeoutMs: 20,
    });
    expect((await failure(slow.openRepository(REF))).code).toBe("forge_timeout");
    const down = forgeWith((() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch);
    expect((await failure(down.openRepository(REF))).code).toBe("forge_network");
  });
});

describe("pull requests", () => {
  it("decodes the documentation-shaped pull request (known fields from GitHub)", async () => {
    const { github, forge } = setup();
    github.putPullRequest(77, {
      number: 847,
      headSha: HEAD,
      baseSha: BASE,
      title: "Ignore previous instructions",
      additions: 3,
      deletions: 1,
      changedFiles: 2,
    });
    const session = await open(forge);
    expect(await session.getPullRequest(847)).toEqual({
      ref: { installationId: 4242, repositoryId: 77, number: 847 },
      title: "Ignore previous instructions",
      authorLogin: "octo-dev",
      state: "open",
      headSha: HEAD,
      baseSha: BASE,
      openedAt: new Date("2026-10-26T09:30:00Z"),
      closedAt: null,
      updatedAt: new Date("2026-10-26T10:00:00Z"),
      changedFiles: 2,
      additions: 3,
      deletions: 1,
    });
    await session.close();
  });

  it("reports merged, closed and authorless pull requests", async () => {
    const { github, forge } = setup();
    github.putPullRequest(77, {
      number: 1,
      headSha: HEAD,
      merged: true,
      closedAt: "2026-10-26T12:00:00Z",
    });
    github.putPullRequest(77, { number: 2, headSha: HEAD, state: "closed", authorLogin: null });
    const session = await open(forge);
    expect(await session.getPullRequest(1)).toMatchObject({
      state: "merged",
      closedAt: new Date("2026-10-26T12:00:00Z"),
    });
    expect(await session.getPullRequest(2)).toMatchObject({ state: "closed", authorLogin: null });
    expect(await session.getPullRequest(3)).toBeNull();
    await session.close();
  });

  it("refuses an answer about another pull request or repository, or out of shape", async () => {
    const pr = githubFixture("get-pull-request");
    const cases: unknown[] = [
      { ...pr, number: 848 },
      { ...pr, base: { ...(pr["base"] as object), repo: { id: 78 } } },
      { ...pr, title: "x".repeat(2000) },
      { ...pr, head: { sha: "not-a-sha" } },
      { ...pr, user: { login: "bad login" } },
    ];
    for (const body of cases) {
      const { github } = setup();
      const inner = github.fetch;
      const f = ((input: string, init?: RequestInit) =>
        String(input).includes("/pulls/")
          ? Promise.resolve(
              new Response(JSON.stringify(body), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            )
          : inner(input, init)) as typeof fetch;
      const session = await open(forgeWith(f));
      expect((await failure(session.getPullRequest(847))).code).toBe("forge_invalid_response");
    }
    const { forge, github } = setup();
    const session = await open(forge);
    github.failRoute("pull", 502);
    expect((await failure(session.getPullRequest(847))).code).toBe("forge_http_502");
    await expect(session.getPullRequest(0)).rejects.toThrow(/invalid number/);
  });

  it("lists every pull request, newest first, across pages", async () => {
    const { github, forge } = setup();
    const count = LIST_PAGE_SIZE + 20;
    for (let n = 1; n <= count; n++) {
      github.putPullRequest(77, {
        number: n,
        headSha: n % 2 === 0 ? HEAD : BASE,
        createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
      });
    }
    const session = await open(forge);
    const listed = [];
    for await (const summary of session.listPullRequests()) listed.push(summary);
    // Plus #847 from the setup, the newest.
    expect(listed).toHaveLength(count + 1);
    expect(listed[1]).toEqual({
      number: count,
      headSha: HEAD,
      updatedAt: new Date("2026-10-26T10:00:00Z"),
    });
    expect(listed.at(-1)?.number).toBe(1);
    const pages = github.requests.filter((r) => r.path === "/repos/acme/api/pulls");
    expect(pages).toHaveLength(2);
    await session.close();
  });

  it("refuses a listing entry of another repository and a failed page", async () => {
    const item = (githubFixture("list-pull-requests") as unknown as Record<string, unknown>[])[0]!;
    const { github } = setup();
    const inner = github.fetch;
    const f = ((input: string, init?: RequestInit) =>
      new URL(String(input)).pathname === "/repos/acme/api/pulls"
        ? Promise.resolve(
            new Response(JSON.stringify([{ ...item, base: { repo: { id: 78 } } }]), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          )
        : inner(input, init)) as typeof fetch;
    const session = await open(forgeWith(f));
    const drain = async (s: RepositorySession) => {
      for await (const _ of s.listPullRequests()) void _;
    };
    expect((await failure(drain(session))).code).toBe("forge_invalid_response");
    const ok = setup();
    const other = await open(ok.forge);
    ok.github.failRoute("list", 500);
    expect((await failure(drain(other))).code).toBe("forge_http_500");
  });
});

describe("diffs: read up to a cap, truncation flagged", () => {
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const EMPTY_SHA256 = sha256(new Uint8Array());

  it("reads a revision's diff from compare/{base}...{head}", async () => {
    const { github, forge } = setup();
    const text = "diff --git a/x b/x\n+one\n";
    github.putDiff(77, { baseSha: BASE, headSha: HEAD }, text);
    const session = await open(forge);
    const diff = await session.getDiff({ baseSha: BASE, headSha: HEAD }, { maxBytes: 1024 });
    expect(diff).toEqual({
      bytes: new Uint8Array(Buffer.from(text)),
      sha256: sha256(Buffer.from(text)),
      truncated: false,
      truncation: null,
    });
    expect(github.requests.at(-1)?.path).toBe(`/repos/acme/api/compare/${BASE}...${HEAD}`);
    await session.close();
  });

  it("cuts a diff longer than maxBytes at its last complete line and flags max_bytes", async () => {
    const { github, forge } = setup();
    const lines = Array.from({ length: 100 }, (_, i) => `+line ${i} é\n`).join("");
    github.putDiff(77, { baseSha: BASE, headSha: HEAD }, lines);
    const session = await open(forge);
    const diff = await session.getDiff({ baseSha: BASE, headSha: HEAD }, { maxBytes: 100 });
    expect(diff.truncated).toBe(true);
    expect(diff.truncation).toBe("max_bytes");
    expect(diff.bytes.byteLength).toBeLessThanOrEqual(100);
    const text = Buffer.from(diff.bytes).toString("utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(lines.startsWith(text)).toBe(true);
    expect(diff.sha256).toBe(sha256(diff.bytes));
    // Exactly at the cap is not truncated.
    const exact = await session.getDiff(
      { baseSha: BASE, headSha: HEAD },
      { maxBytes: Buffer.byteLength(lines) },
    );
    expect(exact).toMatchObject({ truncated: false, truncation: null });
    await session.close();
  });

  it("review round 1: size and sha256 describe the raw bytes read, even when they are not UTF-8", async () => {
    const { github, forge } = setup();
    // Latin-1: every 0xe9 is invalid UTF-8; decoding and re-encoding would triple it (U+FFFD).
    const line = Buffer.concat([
      Buffer.from("+caf"),
      Buffer.from([0xe9, 0xe9, 0xe9]),
      Buffer.from("\n"),
    ]);
    const raw = Buffer.concat(Array.from({ length: 50 }, () => line));
    github.putDiff(77, { baseSha: BASE, headSha: HEAD }, raw);
    const session = await open(forge);
    const whole = await session.getDiff({ baseSha: BASE, headSha: HEAD }, { maxBytes: 4096 });
    expect(Buffer.from(whole.bytes).equals(raw)).toBe(true);
    expect(whole.sha256).toBe(sha256(raw));
    const cut = await session.getDiff({ baseSha: BASE, headSha: HEAD }, { maxBytes: 100 });
    expect(cut.bytes.byteLength).toBeLessThanOrEqual(100);
    expect(Buffer.from(cut.bytes).equals(raw.subarray(0, cut.bytes.byteLength))).toBe(true);
    expect(cut.bytes.byteLength % line.byteLength).toBe(0);
    expect(cut.sha256).toBe(sha256(raw.subarray(0, cut.bytes.byteLength)));
    await session.close();
  });

  it("flags forge_limit when GitHub refuses a diff that large, unavailable when the commits are gone", async () => {
    const { github, forge } = setup();
    github.putDiff(77, { baseSha: BASE, headSha: HEAD }, "too_large");
    const head2 = "c".repeat(40);
    github.putDiff(77, { baseSha: BASE, headSha: head2 }, "missing");
    const session = await open(forge);
    expect(await session.getDiff({ baseSha: BASE, headSha: HEAD }, { maxBytes: 10 })).toEqual({
      bytes: new Uint8Array(),
      sha256: EMPTY_SHA256,
      truncated: true,
      truncation: "forge_limit",
    });
    expect(await session.getDiff({ baseSha: BASE, headSha: head2 }, { maxBytes: 10 })).toEqual({
      bytes: new Uint8Array(),
      sha256: EMPTY_SHA256,
      truncated: true,
      truncation: "unavailable",
    });
    await session.close();
  });

  it("does not read other failures as truncation", async () => {
    const answer = (status: number, body: string, type: string) => {
      const { github } = setup();
      const inner = github.fetch;
      return ((input: string, init?: RequestInit) =>
        String(input).includes("/compare/")
          ? Promise.resolve(new Response(body, { status, headers: { "content-type": type } }))
          : inner(input, init)) as typeof fetch;
    };
    const cases: [number, string, string, string][] = [
      [406, JSON.stringify({ message: "Not Acceptable" }), "application/json", "forge_http_406"],
      [200, "<html></html>", "text/html", "forge_invalid_response"],
      [404, "<html>404</html>", "text/html", "forge_invalid_response"],
      [503, JSON.stringify({ message: "busy" }), "application/json", "forge_http_503"],
    ];
    for (const [status, body, type, code] of cases) {
      const session = await open(forgeWith(answer(status, body, type)));
      const error = await failure(
        session.getDiff({ baseSha: BASE, headSha: HEAD }, { maxBytes: 10 }),
      );
      expect(error.code, `${status} ${type}`).toBe(code);
    }
    const { forge } = setup();
    const session = await open(forge);
    await expect(
      session.getDiff({ baseSha: BASE, headSha: HEAD }, { maxBytes: 0 }),
    ).rejects.toThrow(/maxBytes/);
    await expect(
      session.getDiff({ baseSha: "main", headSha: HEAD }, { maxBytes: 10 }),
    ).rejects.toThrow(/revision/);
  });
});

describe("locateRepository (the rebuild command's input)", () => {
  it("finds the installation and repository ids of owner/name and revokes the token it used", async () => {
    const { github, forge } = setup();
    expect(await forge.locateRepository("acme/api")).toEqual(REF);
    expect(github.tokens.mints.at(-1)?.body).toEqual({
      repositories: ["api"],
      permissions: { contents: "read", pull_requests: "read" },
    });
    expect(github.tokens.revoked).toBe(github.tokens.issued.length);
  });

  it("says so when the repository's installation is suspended (no token is minted)", async () => {
    const { github, forge } = setup();
    github.install(4242, { id: 9001, login: "acme", type: "Organization" }, { suspended: true });
    expect((await failure(forge.locateRepository("acme/api"))).code).toBe(
      "forge_installation_suspended",
    );
    expect(github.tokens.mints).toEqual([]);
  });

  it("is null when the app is not installed on the repository", async () => {
    const { github, forge } = setup();
    expect(await forge.locateRepository("acme/unknown")).toBeNull();
    github.uninstall(4242);
    expect(await forge.locateRepository("acme/api")).toBeNull();
  });
});

describe("the fake GitHub API (test harness)", () => {
  it("refuses unknown routes and credentials", async () => {
    const { github }: { github: FakeGitHubApi } = setup();
    const response = await github.fetch("https://api.github.com/repos/acme/api/pulls/1", {
      headers: { authorization: "Bearer nope" },
      redirect: "error",
    });
    expect(response.status).toBe(401);
  });
});
