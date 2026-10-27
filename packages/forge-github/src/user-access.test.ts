import { inspect } from "node:util";
import {
  ForgeReadError,
  type CollaboratorReader,
  type UserRepositoryAccess,
} from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { parseGitHubAppAuth } from "./app-auth.js";
import { githubEndpoints } from "./app-manifest.js";
import { createGitHubForge, isRepositoryFullName } from "./repositories.js";
import { fakeGitHubApi, FIXTURE_APP_ID, githubFixture, testAppKeys } from "./testing.js";
import { createGitHubUserAccessReader, MAX_REPOSITORY_RESPONSE_BYTES } from "./user-access.js";

/**
 * P3-6 (ADR 0011): as the user, `GET /user` (whose token is it?) and `GET /repos/{owner}/{repo}`
 * (can they read it?); for a repository that is not private, membership on an installation token
 * (`GET /repos/{owner}/{repo}/collaborators/{login}`, 204/404: review round 2, B1). Served by
 * `fakeGitHubApi` from documentation-shaped fixtures (synthetic ids, not recorded).
 */

const keys = testAppKeys();
const auth = parseGitHubAppAuth({ appId: String(FIXTURE_APP_ID), privateKey: keys.privateKeyPem });
const { api } = githubEndpoints({});
const REPO = { installationId: 4242, id: 77, fullName: "acme/api" };
const ALICE = { id: 9101, login: "octo-dev" };

const setup = () => {
  const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
  github.install(4242, { id: 9001, login: "acme", type: "Organization" });
  github.addRepository(4242, { id: REPO.id, fullName: REPO.fullName });
  const token = github.addUser(ALICE);
  const forge = createGitHubForge({
    auth,
    api,
    clock: { now: () => new Date() },
    fetch: github.fetch,
  });
  const reader = createGitHubUserAccessReader({ api, fetch: github.fetch, collaborators: forge });
  const ask = (t = token, repository = REPO, userId = ALICE.id) =>
    reader.readUserRepositoryAccess({ token: t, userId }, repository);
  return { github, token, reader, ask };
};

const jsonResponse = (status: number, body: unknown, type = "application/json; charset=utf-8") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": type } });

type Route = "user" | "repository";
const routeOf = (url: string): Route => (url.endsWith("/user") ? "user" : "repository");

const USER_OK = () => jsonResponse(200, githubFixture("get-authenticated-user"));
const PRIVATE_OK = () => jsonResponse(200, githubFixture("get-repository"));
const PUBLIC_OK = () =>
  jsonResponse(200, { ...githubFixture("get-repository"), private: false, visibility: "public" });

/** A reader on hand-written answers per route, and a scripted membership check. */
const answering = (
  routes: Partial<Record<Route, () => Response | Promise<Response>>> = {},
  membership: () => Promise<boolean> = () => Promise.resolve(true),
) => {
  const seen: { url: string; route: Route; init: RequestInit | undefined }[] = [];
  const asked: { ref: unknown; login: string }[] = [];
  const defaults: Record<Route, () => Response | Promise<Response>> = {
    user: USER_OK,
    repository: PRIVATE_OK,
  };
  const collaborators: CollaboratorReader = {
    isCollaborator: (ref, login) => {
      asked.push({ ref, login });
      return membership();
    },
  };
  const reader = createGitHubUserAccessReader({
    api,
    collaborators,
    fetch: (async (url: string, init?: RequestInit) => {
      const route = routeOf(url);
      seen.push({ url, route, init });
      return (routes[route] ?? defaults[route])();
    }) as typeof fetch,
  });
  const ask = (token = TOKEN, repository = REPO) =>
    reader.readUserRepositoryAccess({ token, userId: ALICE.id }, repository);
  return { reader, seen, asked, ask };
};

const TOKEN = "test-only-user-token-0123456789";

describe("GitHub user repository access: private repositories", () => {
  it("every role grants read; removal is a JSON 404 → not_found", async () => {
    const { github, ask } = setup();
    for (const role of ["read", "triage", "write", "maintain", "admin"] as const) {
      github.setPermission(ALICE.id, REPO.id, role);
      expect(await ask()).toEqual({ access: "read" });
    }
    github.setPermission(ALICE.id, REPO.id, null);
    expect(await ask()).toEqual({ access: "none", reason: "not_found" });
  });

  it("a private repository needs one repository call (plus the identity call), no membership check", async () => {
    const { github, ask } = setup();
    github.setPermission(ALICE.id, REPO.id, "read");
    const before = github.requests.length;
    expect(await ask()).toEqual({ access: "read" });
    expect(github.requests.slice(before)).toEqual([
      { method: "GET", path: "/user", authorized: true },
      { method: "GET", path: "/repos/acme/api", authorized: true },
    ]);
  });

  it("asks as the user, with the token only in the authorization header", async () => {
    const { seen, ask } = answering();
    await ask();
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.github.com/user",
      "https://api.github.com/repos/acme/api",
    ]);
    for (const call of seen) {
      expect(call.url).not.toContain(TOKEN);
      expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.method).toBe("GET");
      expect(call.init?.body).toBeUndefined();
    }
  });

  it("a revoked or expired token is token_rejected", async () => {
    const { github, token, ask } = setup();
    github.setPermission(ALICE.id, REPO.id, "write");
    github.revokeUserToken(token);
    expect(await ask()).toEqual({ access: "none", reason: "token_rejected" });
  });

  it("a repository the app's installation cannot access is not_found, even with a role", async () => {
    const { github, ask } = setup();
    github.setPermission(ALICE.id, REPO.id, "admin");
    github.uninstall(4242);
    expect(await ask()).toEqual({ access: "none", reason: "not_found" });
  });

  it("an answer for another repository id is repository_mismatch", async () => {
    const { github, ask } = setup();
    github.setPermission(ALICE.id, REPO.id, "read");
    expect(await ask(undefined, { ...REPO, id: 78 })).toEqual({
      access: "none",
      reason: "repository_mismatch",
    });
  });
});

describe("B: the token is bound to the member's GitHub identity", () => {
  it("a token of another GitHub user is token_user_mismatch, before the repository is read", async () => {
    const { github, ask } = setup();
    const bob = github.addUser({ id: 9102, login: "octo-other" });
    github.setPermission(9102, REPO.id, "admin");
    const before = github.requests.length;
    expect(await ask(bob)).toEqual({ access: "none", reason: "token_user_mismatch" });
    expect(github.requests.slice(before).map((r) => r.path)).toEqual(["/user"]);
  });

  const identity: [string, () => Response | Promise<Response>, UserRepositoryAccess | string][] = [
    [
      "401",
      () => jsonResponse(401, githubFixture("get-repository.unauthorized")),
      { access: "none", reason: "token_rejected" },
    ],
    ["403", () => jsonResponse(403, { message: "SAML" }), { access: "none", reason: "forbidden" }],
    ["500", () => jsonResponse(500, { message: "x" }), "forge_http_500"],
    ["404", () => jsonResponse(404, githubFixture("get-installation.not-found")), "forge_http_404"],
    ["no id", () => jsonResponse(200, { login: "octo-dev" }), "forge_invalid_response"],
    [
      "id as a string",
      () => jsonResponse(200, { id: "9101", login: "octo-dev" }),
      "forge_invalid_response",
    ],
    ["no login", () => jsonResponse(200, { id: 9101 }), "forge_invalid_response"],
    [
      "a login with a slash",
      () => jsonResponse(200, { id: 9101, login: "a/b" }),
      "forge_invalid_response",
    ],
    [
      "HTML",
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
      "forge_invalid_response",
    ],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed")), "forge_network"],
  ];
  for (const [name, user, expected] of identity) {
    it(`GET /user ${name} denies without reading the repository`, async () => {
      const { seen, ask } = answering({ user });
      const result = await ask().catch((e: unknown) => e);
      if (typeof expected === "string") {
        expect(result).toBeInstanceOf(ForgeReadError);
        expect((result as ForgeReadError).code).toBe(expected);
      } else {
        expect(result).toEqual(expected);
      }
      expect(seen.map((s) => s.route)).toEqual(["user"]);
    });
  }
});

describe("A/B1: public and internal repositories require membership, never effective access", () => {
  for (const visibility of ["public", "internal"] as const) {
    it(`${visibility}: a collaborator (any role) is allowed; removed → not_collaborator`, async () => {
      const { github, ask } = setup();
      github.setVisibility(REPO.id, visibility);
      for (const role of ["read", "triage", "write", "maintain", "admin"] as const) {
        github.setPermission(ALICE.id, REPO.id, role);
        expect(await ask()).toEqual({ access: "read" });
      }
      github.setPermission(ALICE.id, REPO.id, null);
      expect(await ask()).toEqual({ access: "none", reason: "not_collaborator" });
    });

    it(`${visibility}: B1 regression: a non-collaborator for whom /permission says read is denied`, async () => {
      const { github, token, ask } = setup();
      github.setVisibility(REPO.id, visibility);
      // The premise: GitHub's effective-role endpoint says `read` for this non-collaborator.
      const effective = await github.fetch(
        "https://api.github.com/repos/acme/api/collaborators/octo-dev/permission",
        { headers: { authorization: `Bearer ${token}` }, redirect: "error" },
      );
      expect(((await effective.json()) as { permission: string }).permission).toBe("read");
      const before = github.requests.length;
      expect(await ask()).toEqual({ access: "none", reason: "not_collaborator" });
      // Membership is asked on an installation token; /permission is never consulted.
      expect(github.requests.slice(before).map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /user",
        "GET /repos/acme/api",
        "POST /app/installations/4242/access_tokens",
        "GET /repos/acme/api/collaborators/octo-dev",
        "DELETE /installation/token",
      ]);
    });
  }

  it("asks membership for the login GitHub returned for the token, on the org's installation", async () => {
    const { asked, ask } = answering({ repository: PUBLIC_OK });
    expect(await ask()).toEqual({ access: "read" });
    expect(asked).toEqual([{ ref: { installationId: 4242, repositoryId: 77 }, login: "octo-dev" }]);
  });

  const notPrivate: [string, () => Response][] = [
    ["private: false", PUBLIC_OK],
    [
      "private: true, visibility internal",
      () => jsonResponse(200, { ...githubFixture("get-repository"), visibility: "internal" }),
    ],
    [
      "private: false, visibility private (inconsistent)",
      () => jsonResponse(200, { ...githubFixture("get-repository"), private: false }),
    ],
    [
      "an unknown visibility",
      () => jsonResponse(200, { ...githubFixture("get-repository"), visibility: "secret" }),
    ],
  ];
  for (const [name, repository] of notPrivate) {
    it(`treats ${name} as not private (membership check required)`, async () => {
      const { asked, ask } = answering({ repository });
      await ask();
      expect(asked).toHaveLength(1);
    });
  }

  it("a repository answer without visibility is invalid (fail closed)", async () => {
    const body = { ...githubFixture("get-repository") };
    delete body["visibility"];
    const { ask } = answering({ repository: () => jsonResponse(200, body) });
    await expect(ask()).rejects.toMatchObject({ code: "forge_invalid_response" });
  });

  it("not a member → not_collaborator", async () => {
    const { ask } = answering({ repository: PUBLIC_OK }, () => Promise.resolve(false));
    expect(await ask()).toEqual({ access: "none", reason: "not_collaborator" });
  });

  const membershipErrors: [string, () => Promise<boolean>][] = [
    [
      "a ForgeReadError (outage, 401/403, bad answer)",
      () => Promise.reject(new ForgeReadError("http_status", 403)),
    ],
    ["any other error", () => Promise.reject(new Error("boom"))],
    ["a non-boolean answer", () => Promise.resolve("yes" as unknown as boolean)],
    ["undefined", () => Promise.resolve(undefined as unknown as boolean)],
  ];
  for (const [name, membership] of membershipErrors) {
    it(`membership check: ${name} never allows`, async () => {
      const { ask } = answering({ repository: PUBLIC_OK }, membership);
      const result = await ask().catch((e: unknown) => e);
      expect(result).not.toEqual({ access: "read" });
    });
  }

  it("every error of the real membership check denies", async () => {
    for (const status of [401, 403, 500, 429]) {
      const { github, ask } = setup();
      github.setVisibility(REPO.id, "public");
      github.setPermission(ALICE.id, REPO.id, "write");
      github.failRoute("membership", status);
      const result = await ask().catch((e: unknown) => e);
      expect(result).toBeInstanceOf(ForgeReadError);
      expect((result as ForgeReadError).code).toBe(`forge_http_${status}`);
    }
    for (const route of ["token"] as const) {
      const { github, ask } = setup();
      github.setVisibility(REPO.id, "public");
      github.setPermission(ALICE.id, REPO.id, "write");
      github.failRoute(route, 500);
      await expect(ask()).rejects.toMatchObject({ code: "forge_http_500" });
    }
  });

  it("a suspended installation denies on a public repository", async () => {
    const { github, ask } = setup();
    github.setVisibility(REPO.id, "public");
    github.setPermission(ALICE.id, REPO.id, "write");
    github.install(4242, { id: 9001, login: "acme", type: "Organization" }, { suspended: true });
    await expect(ask()).rejects.toMatchObject({ code: "forge_http_403" });
  });
});

const NO_MEMBERS: CollaboratorReader = { isCollaborator: () => Promise.resolve(false) };

describe("repository answers", () => {
  const denials: [string, () => Response, UserRepositoryAccess][] = [
    [
      "pull: false",
      () =>
        jsonResponse(200, {
          ...githubFixture("get-repository"),
          permissions: { admin: false, push: false, pull: false },
        }),
      { access: "none", reason: "no_read_permission" },
    ],
    [
      "401",
      () => jsonResponse(401, githubFixture("get-repository.unauthorized")),
      { access: "none", reason: "token_rejected" },
    ],
    [
      "403 (SSO / rate limit)",
      () => jsonResponse(403, { message: "Resource protected by organization SAML enforcement." }),
      { access: "none", reason: "forbidden" },
    ],
  ];
  for (const [name, repository, expected] of denials) {
    it(`denies on ${name}`, async () => {
      const { ask } = answering({ repository });
      expect(await ask()).toEqual(expected);
    });
  }

  const failures: [string, () => Response | Promise<Response>, string][] = [
    ["500", () => jsonResponse(500, { message: "x" }), "forge_http_500"],
    ["429", () => jsonResponse(429, { message: "x" }), "forge_http_429"],
    ["302", () => new Response(null, { status: 302 }), "forge_http_302"],
    ["204", () => new Response(null, { status: 204 }), "forge_http_204"],
    [
      "a proxy's HTML 404",
      () => new Response("<html>", { status: 404, headers: { "content-type": "text/html" } }),
      "forge_invalid_response",
    ],
    [
      "a JSON 404 that is not GitHub's",
      () => jsonResponse(404, { message: "nope" }),
      "forge_invalid_response",
    ],
    [
      "HTML 200",
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
      "forge_invalid_response",
    ],
    [
      "broken JSON",
      () => new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
      "forge_invalid_response",
    ],
    [
      "no permissions",
      () => jsonResponse(200, { id: 77, private: true, visibility: "private" }),
      "forge_invalid_response",
    ],
    [
      "no private flag",
      () => jsonResponse(200, { id: 77, visibility: "private", permissions: { pull: true } }),
      "forge_invalid_response",
    ],
    [
      "pull as a string",
      () =>
        jsonResponse(200, { ...githubFixture("get-repository"), permissions: { pull: "true" } }),
      "forge_invalid_response",
    ],
    [
      "id as a string",
      () => jsonResponse(200, { ...githubFixture("get-repository"), id: "77" }),
      "forge_invalid_response",
    ],
    [
      "an array",
      () => jsonResponse(200, [githubFixture("get-repository")]),
      "forge_invalid_response",
    ],
    [
      "an oversized body",
      () =>
        jsonResponse(200, {
          ...githubFixture("get-repository"),
          pad: "x".repeat(MAX_REPOSITORY_RESPONSE_BYTES),
        }),
      "forge_invalid_response",
    ],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed")), "forge_network"],
    [
      "a refused redirect",
      () => Promise.reject(new TypeError("unexpected redirect")),
      "forge_network",
    ],
    [
      "a timeout",
      () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
      "forge_timeout",
    ],
  ];
  for (const [name, repository, code] of failures) {
    it(`throws a fixed ForgeReadError on ${name}, without the token`, async () => {
      const { ask } = answering({ repository });
      const error = await ask().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ForgeReadError);
      expect((error as ForgeReadError).code).toBe(code);
      expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    });
  }

  it("a body that fails mid-read is a network failure", async () => {
    const body = new ReadableStream({ pull: (controller) => controller.error(new Error("reset")) });
    const { ask } = answering({
      repository: () =>
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expect(ask()).rejects.toMatchObject({ code: "forge_network" });
  });
});

describe("input checks", () => {
  it("a malformed token is rejected without a request (no header injection)", async () => {
    const { seen, ask, reader } = answering();
    for (const token of [
      "",
      "short",
      `${TOKEN}\r\nx-evil: 1`,
      `${TOKEN} x`,
      "é".repeat(20),
      "x".repeat(513),
    ]) {
      expect(await ask(token)).toEqual({ access: "none", reason: "token_rejected" });
    }
    expect(
      await reader.readUserRepositoryAccess(
        { token: undefined as unknown as string, userId: ALICE.id },
        REPO,
      ),
    ).toEqual({
      access: "none",
      reason: "token_rejected",
    });
    expect(seen).toHaveLength(0);
  });

  it("refuses an invalid repository or user id before any request (no path injection)", async () => {
    const { seen, reader } = answering();
    for (const repository of [
      { installationId: 4242, id: 77, fullName: "acme/../../user" },
      { installationId: 4242, id: 77, fullName: "acme/.." },
      { installationId: 4242, id: 77, fullName: "acme/." },
      { installationId: 4242, id: 77, fullName: "acme/api?x=1" },
      { installationId: 4242, id: 77, fullName: "acme" },
      { installationId: 4242, id: 0, fullName: "acme/api" },
      { installationId: 4242, id: 1.5, fullName: "acme/api" },
      { installationId: 0, id: 77, fullName: "acme/api" },
    ]) {
      await expect(
        reader.readUserRepositoryAccess({ token: TOKEN, userId: ALICE.id }, repository),
      ).rejects.toThrow("invalid repository");
    }
    for (const userId of [0, -1, 1.5, Number.NaN, "9101" as unknown as number]) {
      await expect(reader.readUserRepositoryAccess({ token: TOKEN, userId }, REPO)).rejects.toThrow(
        "invalid user",
      );
    }
    expect(seen).toHaveLength(0);
  });

  it("F: `.` and `..` are not repository names; dotted names still are", () => {
    for (const bad of ["acme/.", "acme/..", "./api", "../api"])
      expect(isRepositoryFullName(bad)).toBe(false);
    for (const good of ["acme/.github", "acme/a..b", "acme/api.js", "acme/..x"]) {
      expect(isRepositoryFullName(good)).toBe(true);
    }
  });

  it("refuses a non-https API base, and one that does not end with /", () => {
    expect(() =>
      createGitHubUserAccessReader({
        api: new URL("http://api.github.com/"),
        collaborators: NO_MEMBERS,
      }),
    ).toThrow();
    expect(() =>
      createGitHubUserAccessReader({
        api: new URL("https://ghe.example.com/api/v3"),
        collaborators: NO_MEMBERS,
      }),
    ).toThrow("must end with /");
    expect(() =>
      createGitHubUserAccessReader({
        api: new URL("https://ghe.example.com/api/v3/"),
        collaborators: NO_MEMBERS,
      }),
    ).not.toThrow();
  });

  it("the reader is a GitHub reader", () => {
    expect(setup().reader.kind).toBe("github");
  });
});
