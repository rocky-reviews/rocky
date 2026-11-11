import { randomBytes } from "node:crypto";
import { githubEndpoints } from "@rocky-reviews/forge-github";
import { createLogger } from "@rocky-reviews/log";
import { SetupStatusResponse } from "@rocky-reviews/core";
import { LlmConfigError, type ProbeResult } from "@rocky-reviews/llm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type AppDeps } from "../app.js";
import { SETUP_RATE_LIMIT_PER_MINUTE } from "../github-app-setup.js";
import { createRateLimits, DEFAULT_RATE_LIMITS } from "../security/rate-limit.js";
import type { SetupChecks } from "./checks.js";
import {
  FINISH_PATH,
  LLM_TEST_INTERVAL_MS,
  LLM_TEST_PATH,
  STATUS_PATH,
  WIZARD_PAGE,
  WIZARD_START,
} from "./routes.js";
import { createSetupSessions } from "./session.js";

/**
 * P10-2 (ADR 0044): the setup wizard's routes. The checks are fakes (their own tests cover them);
 * these tests cover the session, the CSRF check, the answers' shape, the test call's limits and
 * closing setup.
 */

const PUBLIC_URL = new URL("http://127.0.0.1:4310");
const ORIGIN = PUBLIC_URL.origin;
const SECRET_KEY = "sk-ant-api03-SECRET-KEY-VALUE";

interface Harness {
  app: FastifyInstance;
  token: string;
  logs: string[];
  probes: number;
  clock: { now: number };
}

const fakeChecks = (
  h: Pick<Harness, "probes">,
  probe: () => Promise<ProbeResult[]>,
): SetupChecks => ({
  database: async () => ({ state: "ok", details: [] }),
  githubApp: async () => ({
    state: "not_created",
    error: null,
    createPath: "/setup/github-app",
    createBlocked: null,
    credentialsFile: "/setup/github-app.env",
    installUrl: null,
    token: null,
  }),
  llm: () => ({
    state: "not_tested",
    configError: null,
    targets: [
      {
        roles: ["triage", "review", "graph", "ask"],
        provider: "anthropic",
        model: "claude-sonnet-5-5",
      },
    ],
  }),
  probe: async () => {
    h.probes += 1;
    return probe();
  },
  repositories: async () => ({ state: "waiting_for_app", error: null, installations: [] }),
});

const OK: ProbeResult[] = [
  {
    roles: ["triage", "review", "graph", "ask"],
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    outcome: "ok",
    durationMs: 812,
  },
];

let h: Harness;
afterEach(async () => {
  await h?.app.close();
});

const build = async (
  options: {
    probe?: () => Promise<ProbeResult[]>;
    extra?: Partial<AppDeps>;
    page?: boolean;
    clientKey?: (request: FastifyRequest) => string;
  } = {},
): Promise<Harness> => {
  const clientKey = options.clientKey === undefined ? {} : { clientKey: options.clientKey };
  const logs: string[] = [];
  const log = createLogger("setup-wizard-test", {
    destination: { write: (line: string) => void logs.push(line) },
  });
  const token = randomBytes(32).toString("base64url");
  const clock = { now: 1_000_000 };
  const harness: Harness = { app: undefined as never, token, logs, probes: 0, clock };
  const sessions = createSetupSessions({ token, publicUrl: PUBLIC_URL, now: () => clock.now });
  harness.app = buildApp({
    checkDatabase: async () => true,
    log,
    githubAppSetup: {
      token,
      sessions,
      publicUrl: PUBLIC_URL,
      webhookUrl: new URL("https://smee.io/rockyTest"),
      appName: "Rocky Reviews",
      endpoints: githubEndpoints({}),
      credentialsFile: "/nonexistent-rocky-test/github-app.env",
      ...clientKey,
    },
    setupWizard: {
      sessions,
      ...clientKey,
      mode: "setup",
      checks: fakeChecks(harness, options.probe ?? (async () => OK)),
      now: () => clock.now,
      ...(options.page === false
        ? {}
        : {
            page: {
              body: Buffer.from("<!doctype html><title>Rocky</title>"),
              contentType: "text/html; charset=utf-8",
              cacheControl: "no-store",
            },
          }),
    },
    ...options.extra,
  });
  await harness.app.ready();
  return harness;
};

const login = async (harness = h): Promise<string> => {
  const res = await harness.app.inject({
    method: "GET",
    url: `${WIZARD_START}?token=${harness.token}`,
  });
  expect(res.statusCode).toBe(303);
  return String(res.headers["set-cookie"]).split(";")[0]!;
};

const status = async (cookie: string | undefined, harness = h) =>
  harness.app.inject({
    method: "GET",
    url: STATUS_PATH,
    headers: cookie === undefined ? {} : { cookie },
  });

const csrfOf = async (cookie: string): Promise<string> =>
  SetupStatusResponse.parse((await status(cookie)).json()).csrfToken;

const post = async (url: string, cookie: string, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: "POST",
    url,
    headers: {
      cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-rocky-csrf": await csrfOf(cookie),
      ...headers,
    },
  });

describe("setup wizard: the session (P10-2)", () => {
  it("trades the one-time token for a cookie and sends the browser to the wizard", async () => {
    h = await build();
    const res = await h.app.inject({ method: "GET", url: `${WIZARD_START}?token=${h.token}` });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe(WIZARD_PAGE);
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(String(res.headers["set-cookie"])).toMatch(/^rocky_setup=[A-Za-z0-9_-]{43}; Path=\//);
    const again = await h.app.inject({ method: "GET", url: `${WIZARD_START}?token=${h.token}` });
    expect(again.statusCode).toBe(403);
    expect(again.body).toContain("Setup link required");
    expect(h.logs.join("\n")).not.toContain(h.token);
  });

  it("refuses a wrong or missing token", async () => {
    h = await build();
    for (const url of [
      WIZARD_START,
      `${WIZARD_START}?token=nope`,
      `${WIZARD_START}?token=${"A".repeat(43)}`,
    ]) {
      expect((await h.app.inject({ method: "GET", url })).statusCode, url).toBe(403);
    }
  });

  it("shares the session with the manifest flow", async () => {
    h = await build();
    const cookie = await login();
    const res = await h.app.inject({
      method: "GET",
      url: "/setup/github-app",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Continue to GitHub");
  });

  it("serves the wizard page (no session needed, nothing in it) and 404s it without a build", async () => {
    h = await build();
    const res = await h.app.inject({ method: "GET", url: WIZARD_PAGE });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    await h.app.close();
    h = await build({ page: false });
    const dev = await h.app.inject({ method: "GET", url: WIZARD_PAGE });
    expect(dev.statusCode).toBe(404);
    // `pnpm dev` (fix round nit): say where the page is instead of a bare 404.
    expect(dev.body).toContain("ROCKY_PUBLIC_URL=http://127.0.0.1:5173");
  });
});

describe("setup wizard: client addresses behind a proxy (fix round, items 2 and 3)", () => {
  // The server passes the rate limits' client key: ROCKY_TRUST_PROXY decides the address.
  const behindProxy = () =>
    build({
      clientKey: createRateLimits({
        rules: DEFAULT_RATE_LIMITS,
        trustProxy: { kind: "xff", hops: 1 },
      }).clientKey,
    });
  const from = (address: string) => ({ "x-forwarded-for": address });

  it("rate-limits each client address, not the proxy's", async () => {
    h = await behindProxy();
    for (let i = 0; i < SETUP_RATE_LIMIT_PER_MINUTE; i++) {
      await h.app.inject({ method: "GET", url: STATUS_PATH, headers: from("203.0.113.9") });
    }
    const abuser = await h.app.inject({
      method: "GET",
      url: STATUS_PATH,
      headers: from("203.0.113.9"),
    });
    expect(abuser.statusCode).toBe(429);
    const operator = await h.app.inject({
      method: "GET",
      url: STATUS_PATH,
      headers: from("198.51.100.7"),
    });
    expect(operator.statusCode).toBe(403);
    const manifest = await h.app.inject({
      method: "GET",
      url: `/setup/github-app?token=${h.token}`,
      headers: from("198.51.100.7"),
    });
    expect(manifest.statusCode).toBe(303);
  });

  it("crawlers without a token and another client's wrong tokens do not lock out the operator", async () => {
    h = await behindProxy();
    for (let i = 0; i < 40; i++) {
      await h.app.inject({ method: "GET", url: WIZARD_START, headers: from("203.0.113.9") });
    }
    for (let i = 0; i < 20; i++) {
      await h.app.inject({
        method: "GET",
        url: `${WIZARD_START}?token=${randomBytes(32).toString("base64url")}`,
        headers: from("203.0.113.9"),
      });
    }
    const abuser = await h.app.inject({
      method: "GET",
      url: `${WIZARD_START}?token=${h.token}`,
      headers: from("203.0.113.9"),
    });
    expect(abuser.statusCode).toBe(403);
    const operator = await h.app.inject({
      method: "GET",
      url: `${WIZARD_START}?token=${h.token}`,
      headers: from("198.51.100.7"),
    });
    expect(operator.statusCode).toBe(303);
  });
});

describe("setup wizard: status (P10-2)", () => {
  it("needs the session", async () => {
    h = await build();
    const res = await status(undefined);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "setup_session_required" });
  });

  it("answers every step, schema-valid, uncached, with a CSRF token", async () => {
    h = await build();
    const res = await status(await login());
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = SetupStatusResponse.parse(res.json());
    expect(body.mode).toBe("setup");
    expect(body.database.state).toBe("ok");
    expect(body.githubApp.createPath).toBe("/setup/github-app");
    expect(body.llm.state).toBe("not_tested");
    expect(body.llm.results).toBeNull();
    expect(body.repositories.state).toBe("waiting_for_app");
  });
});

describe("setup wizard: the LLM test call (P10-2)", () => {
  it("runs on a same-origin POST with the CSRF token and is reflected in the status", async () => {
    h = await build();
    const cookie = await login();
    const res = await post(LLM_TEST_PATH, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ results: OK });
    expect(h.probes).toBe(1);
    const body = SetupStatusResponse.parse((await status(cookie)).json());
    expect(body.llm.state).toBe("ok");
    expect(body.llm.results).toEqual(OK);
    // Provider, model and outcome are logged; nothing else about the call.
    expect(h.logs.join("\n")).toContain('"outcome":"llm_test"');
  });

  it("is refused without the session, from another origin, or without the token", async () => {
    h = await build();
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const base = { cookie, origin: ORIGIN, "sec-fetch-site": "same-origin", "x-rocky-csrf": csrf };
    for (const headers of [
      { ...base, cookie: "rocky_setup=" + "A".repeat(43) },
      { ...base, origin: "https://evil.example" },
      { ...base, "sec-fetch-site": "cross-site" },
      { ...base, "x-rocky-csrf": "B".repeat(43) },
    ]) {
      const res = await h.app.inject({ method: "POST", url: LLM_TEST_PATH, headers });
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
    }
    expect(h.probes).toBe(0);
  });

  it("runs one at a time, and at most once per interval", async () => {
    let release: () => void = () => undefined;
    h = await build({
      // The first call waits for `release`; later ones answer at once.
      probe: () =>
        h.probes > 1
          ? Promise.resolve(OK)
          : new Promise((resolve) => (release = () => resolve(OK))),
    });
    const cookie = await login();
    const csrf = await csrfOf(cookie);
    const headers = {
      cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "x-rocky-csrf": csrf,
    };
    // `.then` dispatches the injected request; it stays in flight until `release`.
    const first = h.app.inject({ method: "POST", url: LLM_TEST_PATH, headers }).then((r) => r);
    await new Promise((r) => setTimeout(r, 20));
    const second = await h.app.inject({ method: "POST", url: LLM_TEST_PATH, headers });
    expect(second.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
    const soon = await h.app.inject({ method: "POST", url: LLM_TEST_PATH, headers });
    expect(soon.statusCode).toBe(429);
    h.clock.now += LLM_TEST_INTERVAL_MS;
    expect((await h.app.inject({ method: "POST", url: LLM_TEST_PATH, headers })).statusCode).toBe(
      200,
    );
    expect(h.probes).toBe(2);
  });

  it("reports a failing provider as failed, and an unusable configuration as invalid_config", async () => {
    h = await build({ probe: async () => [{ ...OK[0]!, outcome: "auth" }] });
    const cookie = await login();
    expect((await post(LLM_TEST_PATH, cookie)).statusCode).toBe(200);
    expect(SetupStatusResponse.parse((await status(cookie)).json()).llm.state).toBe("failed");
    await h.app.close();

    h = await build({
      probe: async () => {
        throw new LlmConfigError([{ path: "roles.review", message: "no adapter" }]);
      },
    });
    const res = await post(LLM_TEST_PATH, await login());
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "invalid_config" });
  });

  it("never sends or logs a key, whatever the probe throws", async () => {
    h = await build({
      probe: async () => {
        throw new Error(`401 from provider with ${SECRET_KEY}`);
      },
    });
    const res = await post(LLM_TEST_PATH, await login());
    expect(res.statusCode).toBe(409);
    expect(res.body + h.logs.join("\n")).not.toContain(SECRET_KEY);
  });
});

describe("setup wizard: finish (P10-2)", () => {
  it("closes every setup route, the manifest flow's too, until the server restarts", async () => {
    h = await build();
    const cookie = await login();
    const res = await post(FINISH_PATH, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ closed: true });
    for (const url of [
      WIZARD_PAGE,
      STATUS_PATH,
      `${WIZARD_START}?token=${h.token}`,
      "/setup/github-app",
    ]) {
      const after = await h.app.inject({ method: "GET", url, headers: { cookie } });
      expect(after.statusCode, url).toBe(404);
    }
    const again = await h.app.inject({ method: "POST", url: LLM_TEST_PATH, headers: { cookie } });
    expect(again.statusCode).toBe(404);
  });

  it("needs the CSRF check like the test call", async () => {
    h = await build();
    const cookie = await login();
    const res = await h.app.inject({
      method: "POST",
      url: FINISH_PATH,
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect((await status(cookie)).statusCode).toBe(200);
  });
});

describe("setup wizard: registration (P10-2)", () => {
  it("declares a policy for every route, and only /api/setup/* may use the setup CSRF exemption", async () => {
    h = await build();
    const urls = h.app.routePolicies().map((r) => `${r.method} ${r.url}`);
    for (const route of [
      `GET ${WIZARD_START}`,
      `GET ${WIZARD_PAGE}`,
      `GET ${STATUS_PATH}`,
      `POST ${LLM_TEST_PATH}`,
      `POST ${FINISH_PATH}`,
    ]) {
      expect(urls).toContain(route);
    }
    const app = buildApp({ checkDatabase: async () => true });
    expect(() =>
      app.post(
        "/api/elsewhere",
        { config: { policy: { kind: "public", reason: "test" }, csrfExempt: "setup_session" } },
        async () => ({}),
      ),
    ).toThrow(/only for \/api\/setup\//);
    await app.close();
  });
});
