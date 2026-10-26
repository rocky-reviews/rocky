import { ForgeReadError } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { parseGitHubAppAuth } from "./app-auth.js";
import { githubEndpoints } from "./app-manifest.js";
import { createGitHubInstallationReader } from "./installations.js";
import { fakeGitHubApi, FIXTURE_APP_ID, githubFixture, testAppKeys } from "./testing.js";

/**
 * P3-3: re-verification of installation events with GitHub (ADR 0007 §4, ADR 0009). Served from
 * the recorded, sanitised fixtures in `packages/forge-github/fixtures/`.
 */

const keys = testAppKeys();
const auth = parseGitHubAppAuth({ appId: String(FIXTURE_APP_ID), privateKey: keys.privateKeyPem });
const clock = { now: () => new Date() };
const { api } = githubEndpoints({});

const reader = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  createGitHubInstallationReader({
    auth,
    api,
    clock,
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

const respond =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (): Promise<Response> =>
    Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );

const failure = async (promise: Promise<unknown>): Promise<ForgeReadError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ForgeReadError) return error;
    throw error;
  }
  throw new Error("expected a ForgeReadError");
};

describe("getInstallation with the recorded fixtures", () => {
  it("reads an active organization installation (200) as the app", async () => {
    const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
    github.install(4242, { id: 9001, login: "acme", type: "Organization" });
    expect(await reader(github.fetch).getInstallation(4242)).toEqual({
      id: 4242,
      account: { id: 9001, login: "acme", kind: "organization" },
      suspended: false,
    });
    expect(github.requests).toEqual([
      { method: "GET", path: "/app/installations/4242", authorized: true },
    ]);
  });

  it("reads a suspended personal installation as existing and suspended (not deleted)", async () => {
    const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
    github.install(4343, { id: 9101, login: "octo-dev", type: "User" }, { suspended: true });
    expect(await reader(github.fetch).getInstallation(4343)).toEqual({
      id: 4343,
      account: { id: 9101, login: "octo-dev", kind: "user" },
      suspended: true,
    });
  });

  it("returns null only on a 404 (uninstalled)", async () => {
    const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
    expect(await reader(github.fetch).getInstallation(4242)).toBeNull();
    expect(
      await reader(respond(404, githubFixture("get-installation.not-found"))).getInstallation(1),
    ).toBeNull();
  });

  it("parses the raw fixtures exactly as recorded", async () => {
    const org = githubFixture("get-installation.organization");
    expect(await reader(respond(200, org)).getInstallation(4242)).toEqual({
      id: 4242,
      account: { id: 9001, login: "acme", kind: "organization" },
      suspended: false,
    });
    const user = githubFixture("get-installation.user-suspended");
    expect((await reader(respond(200, user)).getInstallation(4343))?.suspended).toBe(true);
  });
});

describe("getInstallation fails closed (never null on an error)", () => {
  it("maps 401/403/5xx to http_status, with the status and nothing else", async () => {
    for (const status of [401, 403, 410, 422, 500, 502, 503]) {
      const error = await failure(
        reader(respond(status, { message: "nope", token: "leak" })).getInstallation(4242),
      );
      expect(error.reason, String(status)).toBe("http_status");
      expect(error.status).toBe(status);
      expect(error.message).not.toMatch(/nope|leak/);
    }
  });

  it("a key GitHub does not accept gets 401, not null", async () => {
    const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: testAppKeys().publicKey });
    github.install(4242, { id: 9001, login: "acme", type: "Organization" });
    const error = await failure(reader(github.fetch).getInstallation(4242));
    expect(error.code).toBe("forge_http_401");
    expect(github.requests[0]?.authorized).toBe(false);
  });

  it("refuses responses about another installation or another app, or of the wrong shape", async () => {
    const org = githubFixture("get-installation.organization");
    const account = org["account"] as Record<string, unknown>;
    for (const [label, body, headers] of [
      ["other id", { ...org, id: 4243 }, {}],
      ["other app", { ...org, app_id: 1 }, {}],
      ["no account", { ...org, account: undefined }, {}],
      ["bad login", { ...org, account: { ...account, login: "../x" } }, {}],
      ["string id", { ...org, id: "4242" }, {}],
      ["not json", "<html>", {}],
      ["html type", org, { "content-type": "text/html" }],
      ["oversized", { ...org, padding: "x".repeat(300 * 1024) }, {}],
      ["declared oversized", org, { "content-length": String(10 * 1024 * 1024) }],
    ] as const) {
      const error = await failure(
        reader(respond(200, body, headers as Record<string, string>)).getInstallation(4242),
      );
      expect(error.reason, label).toBe("invalid_response");
    }
  });

  it("reports an enterprise account as unsupported, not as missing", async () => {
    const github = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
    github.install(4242, { id: 9001, login: "acme", type: "Enterprise" });
    expect((await failure(reader(github.fetch).getInstallation(4242))).reason).toBe(
      "unsupported_account_type",
    );
  });

  it("maps network errors and timeouts; follows no redirect", async () => {
    const network = await failure(
      reader(() => Promise.reject(new TypeError("fetch failed"))).getInstallation(4242),
    );
    expect(network.reason).toBe("network");
    const slow = await failure(
      reader(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error));
          }),
        50,
      ).getInstallation(4242),
    );
    expect(slow.reason).toBe("timeout");
    let seen: RequestInit | undefined;
    await reader((_input, init) => {
      seen = init;
      return respond(404, {})();
    }).getInstallation(4242);
    expect(seen?.redirect).toBe("error");
    expect(seen?.method).toBe("GET");
    const redirect = await failure(
      reader(respond(302, {}, { location: "https://evil.example/" })).getInstallation(4242),
    );
    expect(redirect.reason).toBe("http_status");
  });

  it("only talks to https and only for a valid id", async () => {
    expect(() =>
      createGitHubInstallationReader({ auth, api: new URL("http://api.github.com/"), clock }),
    ).toThrow(/https/);
    await expect(reader(respond(404, {})).getInstallation(0)).rejects.toThrow(/invalid/);
    await expect(reader(respond(404, {})).getInstallation(1.5)).rejects.toThrow(/invalid/);
  });

  it("uses the GHES API base when configured", async () => {
    const ghes = githubEndpoints({ webUrl: "https://ghe.example.com" });
    let url = "";
    await createGitHubInstallationReader({
      auth,
      api: ghes.api,
      clock,
      fetch: (input) => {
        url = String(input);
        return respond(404, {})();
      },
    }).getInstallation(7);
    expect(url).toBe("https://ghe.example.com/api/v3/app/installations/7");
  });
});
