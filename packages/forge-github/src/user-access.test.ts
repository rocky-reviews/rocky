import { inspect } from "node:util";
import { ForgeReadError, type UserRepositoryAccess } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { githubEndpoints } from "./app-manifest.js";
import { fakeGitHubApi, FIXTURE_APP_ID, githubFixture, testAppKeys } from "./testing.js";
import { createGitHubUserAccessReader, MAX_REPOSITORY_RESPONSE_BYTES } from "./user-access.js";

/**
 * P3-6 (ADR 0011): `GET /repos/{owner}/{repo}` as the user. Served by `fakeGitHubApi` from the
 * documentation-shaped fixture `get-repository.json` (synthetic ids, not recorded).
 */

const keys = testAppKeys();
const { api } = githubEndpoints({});
const REPO = { id: 77, fullName: "acme/api" };
const ALICE = { id: 9101, login: "octo-dev" };

const setup = () => {
  const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
  github.install(4242, { id: 9001, login: "acme", type: "Organization" });
  github.addRepository(4242, REPO);
  const token = github.addUser(ALICE);
  const reader = createGitHubUserAccessReader({ api, fetch: github.fetch });
  return { github, token, reader };
};

/** A reader on a hand-written answer. */
const answering = (response: () => Response | Promise<Response>) => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const reader = createGitHubUserAccessReader({
    api,
    fetch: (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return response();
    }) as typeof fetch,
  });
  return { reader, seen };
};

const jsonResponse = (status: number, body: unknown, type = "application/json; charset=utf-8") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": type } });

const TOKEN = "test-only-user-token-0123456789";

describe("GitHub user repository access", () => {
  it("every role grants read; removal is a JSON 404 → not_found", async () => {
    const { github, token, reader } = setup();
    for (const role of ["read", "triage", "write", "maintain", "admin"] as const) {
      github.setPermission(ALICE.id, REPO.id, role);
      expect(await reader.readUserRepositoryAccess({ token }, REPO)).toEqual({ access: "read" });
    }
    github.setPermission(ALICE.id, REPO.id, null);
    expect(await reader.readUserRepositoryAccess({ token }, REPO)).toEqual({
      access: "none",
      reason: "not_found",
    });
    expect(github.requests.at(-1)).toEqual({
      method: "GET",
      path: "/repos/acme/api",
      authorized: true,
    });
  });

  it("asks as the user, with the token only in the authorization header", async () => {
    const { reader, seen } = answering(() => jsonResponse(200, githubFixture("get-repository")));
    await reader.readUserRepositoryAccess({ token: TOKEN }, REPO);
    const [call] = seen;
    expect(call?.url).toBe("https://api.github.com/repos/acme/api");
    expect(call?.url).not.toContain(TOKEN);
    const headers = new Headers(call?.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(call?.init?.redirect).toBe("error");
    expect(call?.init?.method).toBe("GET");
    expect(call?.init?.body).toBeUndefined();
  });

  it("a revoked or expired token is token_rejected", async () => {
    const { github, token, reader } = setup();
    github.setPermission(ALICE.id, REPO.id, "write");
    github.revokeUserToken(token);
    expect(await reader.readUserRepositoryAccess({ token }, REPO)).toEqual({
      access: "none",
      reason: "token_rejected",
    });
  });

  it("an installation token or a foreign user's token gets nothing", async () => {
    const { github, reader } = setup();
    const bob = github.addUser({ id: 9102, login: "octo-other" });
    github.setPermission(ALICE.id, REPO.id, "write");
    expect((await reader.readUserRepositoryAccess({ token: bob }, REPO)).access).toBe("none");
    expect(
      (await reader.readUserRepositoryAccess({ token: "not-a-token-of-this-fake" }, REPO)).access,
    ).toBe("none");
  });

  it("a repository the app's installation cannot access is not_found, even with a role", async () => {
    const { github, token, reader } = setup();
    github.setPermission(ALICE.id, REPO.id, "admin");
    github.uninstall(4242);
    expect(await reader.readUserRepositoryAccess({ token }, REPO)).toEqual({
      access: "none",
      reason: "not_found",
    });
  });

  it("a public repository is readable by any user (ADR 0011 §4)", async () => {
    const { github, token, reader } = setup();
    github.setVisibility(REPO.id, "public");
    expect(await reader.readUserRepositoryAccess({ token }, REPO)).toEqual({ access: "read" });
  });

  it("an answer for another repository id is repository_mismatch", async () => {
    const { github, token, reader } = setup();
    github.setPermission(ALICE.id, REPO.id, "read");
    expect(
      await reader.readUserRepositoryAccess({ token }, { id: 78, fullName: "acme/api" }),
    ).toEqual({
      access: "none",
      reason: "repository_mismatch",
    });
  });

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
  for (const [name, response, expected] of denials) {
    it(`denies on ${name}`, async () => {
      const { reader } = answering(response);
      expect(await reader.readUserRepositoryAccess({ token: TOKEN }, REPO)).toEqual(expected);
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
      () => jsonResponse(200, { id: 77, full_name: "acme/api" }),
      "forge_invalid_response",
    ],
    [
      "pull as a string",
      () => jsonResponse(200, { id: 77, permissions: { pull: "true" } }),
      "forge_invalid_response",
    ],
    [
      "id as a string",
      () => jsonResponse(200, { id: "77", permissions: { pull: true } }),
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
  for (const [name, response, code] of failures) {
    it(`throws a fixed ForgeReadError on ${name}, without the token`, async () => {
      const { reader } = answering(response);
      const error = await reader.readUserRepositoryAccess({ token: TOKEN }, REPO).then(
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
    const body = new ReadableStream({
      pull: (controller) => controller.error(new Error("reset")),
    });
    const { reader } = answering(
      () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(reader.readUserRepositoryAccess({ token: TOKEN }, REPO)).rejects.toMatchObject({
      code: "forge_network",
    });
  });

  it("a malformed token is rejected without a request (no header injection)", async () => {
    const { reader, seen } = answering(() => jsonResponse(200, githubFixture("get-repository")));
    for (const token of [
      "",
      "short",
      `${TOKEN}\r\nx-evil: 1`,
      `${TOKEN} x`,
      "é".repeat(20),
      "x".repeat(513),
    ]) {
      expect(await reader.readUserRepositoryAccess({ token }, REPO)).toEqual({
        access: "none",
        reason: "token_rejected",
      });
    }
    expect(
      await reader.readUserRepositoryAccess({ token: undefined as unknown as string }, REPO),
    ).toEqual({ access: "none", reason: "token_rejected" });
    expect(seen).toHaveLength(0);
  });

  it("refuses an invalid repository before any request (no path injection)", async () => {
    const { reader, seen } = answering(() => jsonResponse(200, githubFixture("get-repository")));
    for (const repository of [
      { id: 77, fullName: "acme/../../user" },
      { id: 77, fullName: "acme/api?x=1" },
      { id: 77, fullName: "acme" },
      { id: 0, fullName: "acme/api" },
      { id: 1.5, fullName: "acme/api" },
    ]) {
      await expect(reader.readUserRepositoryAccess({ token: TOKEN }, repository)).rejects.toThrow(
        "invalid repository",
      );
    }
    expect(seen).toHaveLength(0);
  });

  it("refuses a non-https API base", () => {
    expect(() =>
      createGitHubUserAccessReader({ api: new URL("http://api.github.com/") }),
    ).toThrow();
  });

  it("the reader is a GitHub reader", () => {
    expect(setup().reader.kind).toBe("github");
  });
});
