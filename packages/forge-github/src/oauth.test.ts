import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { githubEndpoints } from "./app-manifest.js";
import {
  createGitHubLogin,
  GitHubLoginError,
  MAX_LOGIN_RESPONSE_BYTES,
  newPkceVerifier,
  pkceChallenge,
} from "./oauth.js";
import {
  fakeGitHubApi,
  fakeGitHubOAuth,
  FIXTURE_APP_ID,
  githubFixture,
  testAppKeys,
} from "./testing.js";

/**
 * P7-1 (ADR 0020): the GitHub App user-authorization flow with PKCE, served by `fakeGitHubOAuth`
 * (web host) and `fakeGitHubApi` (API) from documentation-shaped fixtures, not recordings.
 */

const keys = testAppKeys();
const endpoints = githubEndpoints({});
const CLIENT_ID = "Iv23liTestClient01";
const CLIENT_SECRET = "test-only-client-secret-0123456789abcdef";
const REDIRECT = new URL("https://rocky.example.com/auth/github/callback");
const ALICE = { id: 9101, login: "octo-dev" };
const STATE = "s".repeat(43);

const setup = (options: { expiresInSeconds?: number | null; appId?: number } = {}) => {
  const api = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
  const oauth = fakeGitHubOAuth({
    api,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    ...(options.expiresInSeconds === undefined
      ? {}
      : { expiresInSeconds: options.expiresInSeconds }),
  });
  const login = createGitHubLogin({
    endpoints,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetch: oauth.fetch,
    ...(options.appId === undefined ? {} : { appId: options.appId }),
  });
  const authorize = (verifier = newPkceVerifier()) => {
    const url = login.authorizeUrl({
      redirectUri: REDIRECT,
      state: STATE,
      codeChallenge: pkceChallenge(verifier),
    });
    const code = oauth.approve(url, ALICE).searchParams.get("code") ?? "";
    return { verifier, code, url };
  };
  return { api, oauth, login, authorize };
};

const failsWith = async (promise: Promise<unknown>, reason: string, status?: number) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(GitHubLoginError);
  expect((error as GitHubLoginError).reason).toBe(reason);
  if (status !== undefined) expect((error as GitHubLoginError).status).toBe(status);
  return error as GitHubLoginError;
};

describe("PKCE", () => {
  it("S256 matches RFC 7636 appendix B, and verifiers are 256-bit base64url", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const a = newPkceVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newPkceVerifier()).not.toBe(a);
  });
});

describe("authorizeUrl", () => {
  it("names the client, the exact redirect URI, the state and an S256 challenge, and nothing else", () => {
    const { login } = setup();
    const url = login.authorizeUrl({
      redirectUri: REDIRECT,
      state: STATE,
      codeChallenge: pkceChallenge("v".repeat(43)),
    });
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT.href,
      state: STATE,
      code_challenge: pkceChallenge("v".repeat(43)),
      code_challenge_method: "S256",
    });
  });

  it("refuses a malformed state or challenge, and a client id or secret of the wrong shape", () => {
    const { login } = setup();
    expect(() =>
      login.authorizeUrl({ redirectUri: REDIRECT, state: "short", codeChallenge: "x".repeat(43) }),
    ).toThrow();
    expect(() =>
      login.authorizeUrl({ redirectUri: REDIRECT, state: STATE, codeChallenge: "plain" }),
    ).toThrow();
    expect(() =>
      createGitHubLogin({ endpoints, clientId: "a b", clientSecret: CLIENT_SECRET }),
    ).toThrow("client id");
    expect(() =>
      createGitHubLogin({ endpoints, clientId: CLIENT_ID, clientSecret: "short" }),
    ).toThrow("client secret");
    expect(() =>
      createGitHubLogin({
        endpoints: { web: new URL("http://github.com/"), api: endpoints.api },
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      }),
    ).toThrow("https");
  });
});

describe("exchangeCode", () => {
  it("exchanges a code with the verifier for an expiring user token; the refresh token is dropped", async () => {
    const t0 = Date.now();
    const { login, authorize, oauth } = setup();
    const { code, verifier } = authorize();
    const token = await login.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT });
    expect(token.accessToken).toBe(oauth.issued[0]);
    expect(Object.keys(token).sort()).toEqual(["accessToken", "expiresAt"]);
    // Counted from before the request: never later than GitHub's own expiry.
    expect(token.expiresAt?.getTime()).toBeGreaterThanOrEqual(t0 + 28_800_000);
    expect(token.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 28_800_000);
    expect(oauth.exchanges).toEqual([{ clientOk: true, verifierOk: true, outcome: "issued" }]);
    expect(inspect(token)).not.toContain("refresh");
  });

  it("a token that does not expire has no expiry", async () => {
    const { login, authorize } = setup({ expiresInSeconds: null });
    const { code, verifier } = authorize();
    const token = await login.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT });
    expect(token.expiresAt).toBeNull();
  });

  it("PKCE: a wrong verifier is bad_verification_code, and the code is spent", async () => {
    const { login, authorize } = setup();
    const { code, verifier } = authorize();
    await failsWith(
      login.exchangeCode({ code, codeVerifier: newPkceVerifier(), redirectUri: REDIRECT }),
      "bad_verification_code",
    );
    await failsWith(
      login.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT }),
      "bad_verification_code",
    );
  });

  it("a code works once (replay is bad_verification_code)", async () => {
    const { login, authorize } = setup();
    const { code, verifier } = authorize();
    await login.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT });
    await failsWith(
      login.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT }),
      "bad_verification_code",
    );
  });

  it("maps GitHub's OAuth errors (200 + error) to fixed reasons and never echoes the description", async () => {
    const { login, authorize, oauth } = setup();
    for (const [error, reason] of [
      ["incorrect_client_credentials", "client_rejected"],
      ["redirect_uri_mismatch", "oauth_error"],
      ["something_new", "oauth_error"],
    ] as const) {
      oauth.failExchange(error);
      const { code, verifier } = authorize();
      const e = await failsWith(
        login.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT }),
        reason,
      );
      expect(e.message).not.toMatch(/incorrect or expired|docs\.github\.com/);
    }
    oauth.failExchange(500);
    const { code, verifier } = authorize();
    await failsWith(
      login.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT }),
      "http_status",
      500,
    );
  });

  it("refuses a malformed code or verifier without a request, and never puts them in an error", async () => {
    const { login, oauth } = setup();
    for (const code of ["", "short", "a b c d e f g h", "x".repeat(200)]) {
      const e = await failsWith(
        login.exchangeCode({ code, codeVerifier: newPkceVerifier(), redirectUri: REDIRECT }),
        "bad_verification_code",
      );
      if (code !== "") expect(inspect(e)).not.toContain(code);
    }
    await failsWith(
      login.exchangeCode({ code: "abcdefgh12", codeVerifier: "short", redirectUri: REDIRECT }),
      "bad_verification_code",
    );
    expect(oauth.exchanges).toEqual([]);
  });

  it("sends the secret only in the token request body, never as a header or in the URL", async () => {
    const seen: { url: string; headers: Headers; body: string }[] = [];
    const { oauth, authorize } = setup();
    const login = createGitHubLogin({
      endpoints,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: (async (input: string, init: RequestInit) => {
        seen.push({ url: input, headers: new Headers(init.headers), body: String(init.body) });
        return oauth.fetch(input, init);
      }) as typeof fetch,
    });
    const { code, verifier } = authorize();
    const token = await login.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT });
    await login.readUser(token.accessToken);
    expect(seen[0]?.url).not.toContain(CLIENT_SECRET);
    expect(seen[0]?.body).toContain(`client_secret=${CLIENT_SECRET}`);
    expect(seen[0]?.body).toContain(`code_verifier=${verifier}`);
    expect(seen[1]?.url).toBe("https://api.github.com/user");
    expect(seen[1]?.headers.get("authorization")).toBe(`Bearer ${token.accessToken}`);
    for (const s of seen) {
      expect([...s.headers.values()].join(" ")).not.toContain(CLIENT_SECRET);
    }
  });

  it("fails closed on a non-JSON, oversized, mistyped or redirecting answer, a timeout or a network error", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response("access_token=x&token_type=bearer", { status: 200 }),
      () =>
        new Response("x".repeat(MAX_LOGIN_RESPONSE_BYTES + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response(JSON.stringify({ access_token: "tiny", token_type: "bearer" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () =>
        new Response(JSON.stringify({ access_token: "x".repeat(40), token_type: "mac" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    ];
    for (const answer of answers) {
      const login = createGitHubLogin({
        endpoints,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        fetch: (async () => answer()) as unknown as typeof fetch,
      });
      const error = await login
        .exchangeCode({
          code: "abcdefgh12",
          codeVerifier: newPkceVerifier(),
          redirectUri: REDIRECT,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubLoginError);
      expect(["invalid_response", "http_status"]).toContain((error as GitHubLoginError).reason);
    }
    const network = createGitHubLogin({
      endpoints,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    await failsWith(
      network.exchangeCode({
        code: "abcdefgh12",
        codeVerifier: newPkceVerifier(),
        redirectUri: REDIRECT,
      }),
      "network",
    );
    const slow = createGitHubLogin({
      endpoints,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      timeoutMs: 5,
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })),
          );
        })) as unknown as typeof fetch,
    });
    await failsWith(
      slow.exchangeCode({
        code: "abcdefgh12",
        codeVerifier: newPkceVerifier(),
        redirectUri: REDIRECT,
      }),
      "timeout",
    );
  });
});

describe("readUser and listInstallations", () => {
  it("identifies the user by numeric id and lists the app's installations they can access", async () => {
    const { api, login, authorize } = setup({ appId: FIXTURE_APP_ID });
    api.install(4242, { id: 9001, login: "acme", type: "Organization" });
    api.install(4343, { id: 9002, login: "beta", type: "Organization" });
    api.install(4444, { id: 9101, login: "octo-dev", type: "User" }, { suspended: true });
    api.grantInstallation(ALICE.id, 4242);
    api.grantInstallation(ALICE.id, 4444);
    const { code, verifier } = authorize();
    const { accessToken } = await login.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    });
    expect(await login.readUser(accessToken)).toEqual(ALICE);
    // 4343 is not granted to this user; 4444 is suspended.
    expect(await login.listInstallations(accessToken)).toEqual([
      { installationId: 4242, accountId: 9001, accountLogin: "acme", accountType: "Organization" },
    ]);
    // A User account's installation is reported as such (only its owner is a member).
    api.install(4545, { id: 9101, login: "octo-dev", type: "User" });
    api.grantInstallation(ALICE.id, 4545);
    expect(await login.listInstallations(accessToken)).toContainEqual({
      installationId: 4545,
      accountId: 9101,
      accountLogin: "octo-dev",
      accountType: "User",
    });
  });

  it("leaves out installations of another app id, and pages through many", async () => {
    const { api, login, authorize } = setup({ appId: 777 });
    api.install(4242, { id: 9001, login: "acme", type: "Organization" });
    api.grantInstallation(ALICE.id, 4242);
    const { code, verifier } = authorize();
    const { accessToken } = await login.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    });
    expect(await login.listInstallations(accessToken)).toEqual([]);

    const many = setup();
    for (let i = 1; i <= 150; i++) {
      many.api.install(10_000 + i, { id: 20_000 + i, login: `org${i}`, type: "Organization" });
      many.api.grantInstallation(ALICE.id, 10_000 + i);
    }
    const a = many.authorize();
    const t = await many.login.exchangeCode({
      code: a.code,
      codeVerifier: a.verifier,
      redirectUri: REDIRECT,
    });
    expect(await many.login.listInstallations(t.accessToken)).toHaveLength(150);
  });

  it("401 is token_rejected, 403 forbidden, other statuses and bad shapes fail closed", async () => {
    const { api, login, authorize } = setup();
    const { code, verifier } = authorize();
    const { accessToken } = await login.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    });
    api.failRoute("user", 401);
    await failsWith(login.readUser(accessToken), "token_rejected", 401);
    api.failRoute("installations", 403);
    await failsWith(login.listInstallations(accessToken), "forbidden", 403);
    api.failRoute("installations", 502);
    await failsWith(login.listInstallations(accessToken), "http_status", 502);
    api.revokeUserToken(accessToken);
    await failsWith(login.readUser(accessToken), "token_rejected");
    await failsWith(login.readUser("bad token"), "token_rejected");
    const shaped = createGitHubLogin({
      endpoints,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: (async () =>
        new Response(JSON.stringify({ ...githubFixture("get-authenticated-user"), id: "9101" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await failsWith(shaped.readUser("x".repeat(40)), "invalid_response");
    await failsWith(shaped.listInstallations("x".repeat(40)), "invalid_response");
  });

  it("leaves out installations on accounts that are neither an organization nor a user", async () => {
    const fixture = githubFixture("list-user-installations")["installations"] as {
      account: object;
    }[];
    const odd = createGitHubLogin({
      endpoints,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: (async () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            installations: [
              { ...fixture[0], account: { ...fixture[0]?.account, type: "Enterprise" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    expect(await odd.listInstallations("x".repeat(40))).toEqual([]);
  });

  it("refuses an endless installation list", async () => {
    const full = {
      total_count: 5000,
      installations: Array.from({ length: 100 }, (_, i) => ({
        ...(githubFixture("list-user-installations")["installations"] as object[])[0],
        id: i + 1,
      })),
    };
    const endless = createGitHubLogin({
      endpoints,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetch: (async () =>
        new Response(JSON.stringify(full), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    await failsWith(endless.listInstallations("x".repeat(40)), "too_many_installations");
  });
});

describe("orgMembershipRole (review round 1: only real members count; P7-2: the role)", () => {
  const ACME = { id: 9001, login: "acme" };
  const signedIn = async () => {
    const env = setup();
    env.api.install(4242, { ...ACME, type: "Organization" });
    env.api.grantInstallation(ALICE.id, 4242);
    const { code, verifier } = env.authorize();
    const { accessToken } = await env.login.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    });
    return { ...env, accessToken };
  };

  it("a role only for an active membership of that organization, for that user", async () => {
    const { api, login, accessToken } = await signedIn();
    // An outside collaborator: the installation is visible, but there is no membership (404).
    expect(await login.orgMembershipRole(accessToken, ACME, ALICE.id)).toBe(null);
    api.setOrgMembership(ACME.id, ALICE.id, "pending");
    expect(await login.orgMembershipRole(accessToken, ACME, ALICE.id)).toBe(null);
    api.setOrgMembership(ACME.id, ALICE.id, "active");
    expect(await login.orgMembershipRole(accessToken, ACME, ALICE.id)).toBe("member");
    api.setOrgMembership(ACME.id, ALICE.id, "active", "admin");
    expect(await login.orgMembershipRole(accessToken, ACME, ALICE.id)).toBe("admin");
    // A billing manager (or any other role) is not an organization member: fail closed.
    api.setOrgMembership(ACME.id, ALICE.id, "active", "billing_manager");
    expect(await login.orgMembershipRole(accessToken, ACME, ALICE.id)).toBeNull();
    api.setOrgMembership(ACME.id, ALICE.id, "pending", "admin");
    expect(await login.orgMembershipRole(accessToken, ACME, ALICE.id)).toBeNull();
    api.setOrgMembership(ACME.id, ALICE.id, "active");
    // The answer must be about the asked org and user (ids, not logins).
    expect(await login.orgMembershipRole(accessToken, { ...ACME, id: 9002 }, ALICE.id)).toBe(null);
    expect(await login.orgMembershipRole(accessToken, ACME, 9999)).toBe(null);
  });

  it("fails closed: 401, 403, other statuses, a non-JSON 404 and bad shapes are errors", async () => {
    const { api, login, accessToken } = await signedIn();
    api.setOrgMembership(ACME.id, ALICE.id, "active");
    api.failRoute("org_membership", 401);
    await failsWith(login.orgMembershipRole(accessToken, ACME, ALICE.id), "token_rejected", 401);
    api.failRoute("org_membership", 403);
    await failsWith(login.orgMembershipRole(accessToken, ACME, ALICE.id), "forbidden", 403);
    api.failRoute("org_membership", 500);
    await failsWith(login.orgMembershipRole(accessToken, ACME, ALICE.id), "http_status", 500);
    await failsWith(login.orgMembershipRole("bad token", ACME, ALICE.id), "token_rejected");
    await expect(
      login.orgMembershipRole(accessToken, { id: 9001, login: "../evil" }, ALICE.id),
    ).rejects.toThrow("invalid organization login");
    await expect(
      login.orgMembershipRole(accessToken, { id: 0, login: "acme" }, ALICE.id),
    ).rejects.toThrow("invalid id");
    const answer = (status: number, body: string, type = "application/json") =>
      createGitHubLogin({
        endpoints,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        fetch: (async () =>
          new Response(body, {
            status,
            headers: { "content-type": type },
          })) as unknown as typeof fetch,
      });
    await failsWith(
      answer(404, "<html>", "text/html").orgMembershipRole("x".repeat(40), ACME, ALICE.id),
      "invalid_response",
    );
    const fixture = githubFixture("get-user-org-membership");
    await failsWith(
      answer(200, JSON.stringify({ ...fixture, state: 1 })).orgMembershipRole(
        "x".repeat(40),
        ACME,
        ALICE.id,
      ),
      "invalid_response",
    );
    const noRole: Record<string, unknown> = { ...fixture };
    delete noRole["role"];
    await failsWith(
      answer(200, JSON.stringify({ ...noRole, state: "active" })).orgMembershipRole(
        "x".repeat(40),
        ACME,
        ALICE.id,
      ),
      "invalid_response",
    );
  });
});
