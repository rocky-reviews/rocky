import { inspect } from "node:util";
import { ForgeReadError } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { parseGitHubAppAuth } from "./app-auth.js";
import { githubEndpoints } from "./app-manifest.js";
import { COLLABORATOR_TOKEN_PERMISSIONS, createGitHubForge } from "./repositories.js";
import { fakeGitHubApi, FIXTURE_APP_ID, githubFixture, testAppKeys } from "./testing.js";

/**
 * P3-6 review round 2 (ADR 0011 §2, step 3): collaborator status by membership, not effective
 * access. `GET /repos/{owner}/{repo}/collaborators/{username}` (204 / 404) on an installation
 * token minted for the one repository with `metadata: read` only, checked and revoked after use.
 * Served by `fakeGitHubApi` from documentation-shaped fixtures (synthetic ids, not recorded).
 */

const keys = testAppKeys();
const auth = parseGitHubAppAuth({ appId: String(FIXTURE_APP_ID), privateKey: keys.privateKeyPem });
const { api } = githubEndpoints({});
const REF = { installationId: 4242, repositoryId: 77 };
const ALICE = { id: 9101, login: "octo-dev" };

const setup = () => {
  const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
  github.install(4242, { id: 9001, login: "acme", type: "Organization" });
  github.addRepository(4242, { id: 77, fullName: "acme/api" });
  github.addRepository(4242, { id: 78, fullName: "acme/web" });
  github.addUser(ALICE);
  const forge = createGitHubForge({
    auth,
    api,
    clock: { now: () => new Date() },
    fetch: github.fetch,
  });
  return { github, forge };
};

/** A fetch answering the mint with `mint` and the membership call with `membership`. */
const scripted = (mint: () => Response, membership: () => Response | Promise<Response>) => {
  const seen: { method: string; path: string }[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    seen.push({ method: init?.method ?? "GET", path: url.pathname });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.pathname.endsWith("/access_tokens")) return mint();
    return membership();
  };
  const forge = createGitHubForge({
    auth,
    api,
    clock: { now: () => new Date() },
    fetch: fetchImpl as typeof fetch,
  });
  return { forge, seen };
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const MINTED = () =>
  json(201, {
    ...githubFixture("post-installation-access-token"),
    token: "test-only-installation-token-0123456789",
    permissions: { metadata: "read" },
  });

describe("isCollaborator: membership on an installation token, metadata: read only", () => {
  it("204 for a collaborator of any role; 404 once removed; never effective access", async () => {
    const { github, forge } = setup();
    for (const role of ["read", "triage", "write", "maintain", "admin"] as const) {
      github.setPermission(ALICE.id, 77, role);
      expect(await forge.isCollaborator(REF, ALICE.login)).toBe(true);
    }
    github.setPermission(ALICE.id, 77, null);
    // On a public repository GitHub's /permission endpoint would say `read` for this user.
    github.setVisibility(77, "public");
    expect(await forge.isCollaborator(REF, ALICE.login)).toBe(false);
  });

  it("mints for exactly the one repository with metadata: read, and revokes after use", async () => {
    const { github, forge } = setup();
    github.setPermission(ALICE.id, 77, "read");
    const revokedBefore = github.tokens.revoked;
    expect(await forge.isCollaborator(REF, ALICE.login)).toBe(true);
    expect(github.tokens.mints.at(-1)).toEqual({
      installationId: 4242,
      body: { repository_ids: [77], permissions: { metadata: "read" } },
    });
    expect(COLLABORATOR_TOKEN_PERMISSIONS).toEqual({ metadata: "read" });
    expect(github.tokens.revoked).toBe(revokedBefore + 1);
    const paths = github.requests.slice(-3).map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual([
      "POST /app/installations/4242/access_tokens",
      "GET /repos/acme/api/collaborators/octo-dev",
      "DELETE /installation/token",
    ]);
    expect(github.requests.at(-2)?.authorized).toBe(true);
  });

  it("the token cannot answer for another repository of the installation", async () => {
    const { github, forge } = setup();
    github.setPermission(ALICE.id, 78, "admin");
    expect(await forge.isCollaborator(REF, ALICE.login)).toBe(false);
  });

  it("a repository the installation cannot access, or a gone installation, is false", async () => {
    const { github, forge } = setup();
    github.setPermission(ALICE.id, 77, "admin");
    expect(
      await forge.isCollaborator({ installationId: 4242, repositoryId: 99 }, ALICE.login),
    ).toBe(false);
    github.uninstall(4242);
    expect(await forge.isCollaborator(REF, ALICE.login)).toBe(false);
  });

  it("a suspended installation throws (deny), and no membership call is made", async () => {
    const { github, forge } = setup();
    github.install(4242, { id: 9001, login: "acme", type: "Organization" }, { suspended: true });
    const before = github.requests.length;
    await expect(forge.isCollaborator(REF, ALICE.login)).rejects.toMatchObject({
      code: "forge_http_403",
    });
    expect(github.requests.slice(before).map((r) => r.path)).toEqual([
      "/app/installations/4242/access_tokens",
    ]);
  });

  it("refuses and revokes a token wider than metadata: read, or for another repository", async () => {
    const fixture = githubFixture("post-installation-access-token");
    const repo = (fixture["repositories"] as Record<string, unknown>[])[0]!;
    const answers = [
      { ...fixture, permissions: { metadata: "read", contents: "read" } },
      { ...fixture, permissions: { metadata: "write" } },
      { ...fixture, permissions: { metadata: "read" }, repositories: [{ ...repo, id: 78 }] },
      { ...fixture, permissions: { metadata: "read" }, repositories: [repo, { ...repo, id: 78 }] },
    ];
    for (const body of answers) {
      const { forge, seen } = scripted(
        () => json(201, body),
        () => new Response(null, { status: 204 }),
      );
      await expect(forge.isCollaborator(REF, ALICE.login)).rejects.toMatchObject({
        code: "forge_invalid_response",
      });
      expect(seen.map((s) => s.method)).toEqual(["POST", "DELETE"]);
    }
  });

  const failures: [string, () => Response | Promise<Response>, string][] = [
    ["401", () => json(401, { message: "Bad credentials" }), "forge_http_401"],
    [
      "403",
      () => json(403, { message: "Resource not accessible by integration" }),
      "forge_http_403",
    ],
    ["500", () => json(500, { message: "x" }), "forge_http_500"],
    ["200 (not the documented 204)", () => json(200, {}), "forge_http_200"],
    ["302", () => new Response(null, { status: 302 }), "forge_http_302"],
    [
      "a JSON 404 that is not GitHub's",
      () => json(404, { message: "nope" }),
      "forge_invalid_response",
    ],
    [
      "a proxy's HTML 404",
      () => new Response("<html>", { status: 404, headers: { "content-type": "text/html" } }),
      "forge_invalid_response",
    ],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed")), "forge_network"],
  ];
  for (const [name, membership, code] of failures) {
    it(`throws on ${name} and still revokes the token, without leaking it`, async () => {
      const { forge, seen } = scripted(MINTED, membership);
      const error = await forge.isCollaborator(REF, ALICE.login).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForgeReadError);
      expect((error as ForgeReadError).code).toBe(code);
      expect(inspect(error, { depth: 10, showHidden: true })).not.toContain(
        "test-only-installation",
      );
      expect(seen.at(-1)).toEqual({ method: "DELETE", path: "/installation/token" });
    });
  }

  it("refuses an invalid login or ids before any request", async () => {
    const { forge, seen } = scripted(MINTED, () => new Response(null, { status: 204 }));
    for (const login of ["", "a/b", "../x", "a b", "-x", "x".repeat(40), "octo[bot]"]) {
      await expect(forge.isCollaborator(REF, login)).rejects.toThrow("invalid login");
    }
    for (const ref of [
      { installationId: 0, repositoryId: 77 },
      { installationId: 4242, repositoryId: 1.5 },
    ]) {
      await expect(forge.isCollaborator(ref, ALICE.login)).rejects.toThrow("invalid ids");
    }
    expect(seen).toHaveLength(0);
  });
});
