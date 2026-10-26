import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { buildGitHubAppManifest, githubEndpoints } from "@rocky-reviews/forge-github";
import { createLogger } from "@rocky-reviews/log";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import {
  SETUP_COOKIE,
  SETUP_SESSION_TTL_MS,
  SETUP_STATE_TTL_MS,
  type GitHubAppSetupDeps,
} from "./github-app-setup.js";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;

const PUBLIC_URL = new URL("http://127.0.0.1:4310");
const WEBHOOK_URL = new URL("https://smee.io/rockyTestChannel");

interface Conversion {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
  permissions: Record<string, string>;
  events: string[];
}

const conversion = (overrides: Partial<Conversion> = {}): Conversion => ({
  id: 98765,
  slug: "rocky-reviews-h3",
  client_id: "Iv23liQWERTY12345678",
  client_secret: randomBytes(20).toString("hex"),
  webhook_secret: randomBytes(20).toString("hex"),
  pem: PEM,
  permissions: { contents: "read", pull_requests: "write", checks: "read", metadata: "read" },
  events: ["pull_request"],
  ...overrides,
});

interface Harness {
  app: FastifyInstance;
  token: string;
  file: string;
  dir: string;
  calls: string[];
  logs: string[];
  clock: { now: number };
  respond: (code: string) => Response | Promise<Response>;
}

let h: Harness;

const build = async (
  options: Partial<GitHubAppSetupDeps> & { respond?: Harness["respond"] } = {},
): Promise<Harness> => {
  const dir = await mkdtemp(join(tmpdir(), "rocky-setup-"));
  const logs: string[] = [];
  const log = createLogger("setup-test", {
    destination: { write: (line: string) => void logs.push(line) },
  });
  const calls: string[] = [];
  const clock = { now: Date.parse("2026-10-26T12:00:00Z") };
  const harness: Harness = {
    app: undefined as unknown as FastifyInstance,
    token: randomBytes(32).toString("base64url"),
    file: join(dir, "rocky", "github-app.env"),
    dir,
    calls,
    logs,
    clock,
    respond:
      options.respond ??
      (() =>
        new Response(JSON.stringify(conversion()), {
          status: 201,
          headers: { "content-type": "application/json" },
        })),
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const code = /app-manifests\/([^/]+)\/conversions$/.exec(url)?.[1] ?? "";
    return harness.respond(code);
  }) as typeof fetch;
  harness.app = buildApp({
    checkDatabase: async () => true,
    log,
    githubAppSetup: {
      token: harness.token,
      publicUrl: PUBLIC_URL,
      webhookUrl: WEBHOOK_URL,
      appName: "Rocky Reviews",
      endpoints: githubEndpoints({}),
      credentialsFile: harness.file,
      fetch: fetchImpl,
      now: () => clock.now,
      ...options,
    },
  });
  await harness.app.ready();
  return harness;
};

beforeEach(async () => {
  h = await build();
});
afterEach(async () => {
  await h.app.close();
  await rm(h.dir, { recursive: true, force: true });
});

const setCookieOf = (res: LightMyRequestResponse): string | undefined => {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw[0] : raw;
};

/** Opens the token URL and returns the session cookie pair (`name=value`). */
const login = async (harness = h, query = ""): Promise<string> => {
  const res = await harness.app.inject({
    method: "GET",
    url: `/setup/github-app?token=${harness.token}${query}`,
  });
  expect(res.statusCode).toBe(303);
  const cookie = setCookieOf(res);
  expect(cookie).toBeDefined();
  return cookie!.split(";")[0]!;
};

const unescapeHtml = (s: string) =>
  s
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/** Renders the setup page and returns the form action, the state and the manifest. */
const page = async (cookie: string, query = "", harness = h) => {
  const res = await harness.app.inject({
    method: "GET",
    url: `/setup/github-app${query}`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  const action = unescapeHtml(/<form method="post" action="([^"]+)"/.exec(res.body)?.[1] ?? "");
  const manifest = unescapeHtml(/name="manifest" value="([^"]+)"/.exec(res.body)?.[1] ?? "");
  const state = new URL(action).searchParams.get("state") ?? "";
  return { res, action, state, manifest: JSON.parse(manifest) as unknown };
};

const callback = (cookie: string | undefined, query: string, harness = h) =>
  harness.app.inject({
    method: "GET",
    url: `/setup/github-app/callback?${query}`,
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });

const CODE = "0f1e2d3c4b5a69788796";

/** Changes the last character to a different one (never a no-op). */
const tamper = (value: string): string => `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;

describe("setup token (one-time, from the server terminal)", () => {
  it("refuses the page without a token or session", async () => {
    const res = await h.app.inject({ method: "GET", url: "/setup/github-app" });
    expect(res.statusCode).toBe(403);
    expect(setCookieOf(res)).toBeUndefined();
    expect(res.body).not.toContain("<form");
  });

  it("refuses a wrong, truncated, padded or repeated token", async () => {
    for (const token of [
      "x",
      h.token.slice(0, -1),
      `${h.token}A`,
      randomBytes(32).toString("base64url"),
      `${h.token}&token=${h.token}`,
    ]) {
      const res = await h.app.inject({ method: "GET", url: `/setup/github-app?token=${token}` });
      expect(res.statusCode, token).toBe(403);
      expect(setCookieOf(res)).toBeUndefined();
    }
  });

  it("exchanges the token once for an HttpOnly, SameSite=Lax session and redirects to a fixed path", async () => {
    const res = await h.app.inject({ method: "GET", url: `/setup/github-app?token=${h.token}` });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe("/setup/github-app");
    const cookie = setCookieOf(res)!;
    expect(cookie).toMatch(new RegExp(`^${SETUP_COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/setup/github-app");
    expect(cookie).toContain(`Max-Age=${SETUP_SESSION_TTL_MS / 1000}`);
    // The cookie is not the token.
    expect(cookie).not.toContain(h.token);
    // Second use of the token: refused.
    const again = await h.app.inject({ method: "GET", url: `/setup/github-app?token=${h.token}` });
    expect(again.statusCode).toBe(403);
  });

  it("marks the cookie Secure when the public URL is https", async () => {
    const secure = await build({ publicUrl: new URL("https://rocky.example.com") });
    try {
      const res = await secure.app.inject({
        method: "GET",
        url: `/setup/github-app?token=${secure.token}`,
      });
      expect(setCookieOf(res)).toContain("Secure");
    } finally {
      await secure.app.close();
      await rm(secure.dir, { recursive: true, force: true });
    }
  });

  it("keeps only a validated organization in the redirect (no open redirect)", async () => {
    const ok = await h.app.inject({
      method: "GET",
      url: `/setup/github-app?token=${h.token}&org=rocky-reviews`,
    });
    expect(ok.headers["location"]).toBe("/setup/github-app?org=rocky-reviews");
    const h2 = await build();
    try {
      for (const evil of ["https://evil.example", "//evil.example", "a/../../x", "%0d%0aX:1"]) {
        const res = await h2.app.inject({
          method: "GET",
          url: `/setup/github-app?token=${h2.token}&org=${encodeURIComponent(evil)}`,
        });
        expect(res.statusCode, evil).toBe(400);
      }
    } finally {
      await h2.app.close();
      await rm(h2.dir, { recursive: true, force: true });
    }
  });

  it("expires the session", async () => {
    const cookie = await login();
    h.clock.now += SETUP_SESSION_TTL_MS + 1;
    const res = await h.app.inject({
      method: "GET",
      url: "/setup/github-app",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a forged session cookie", async () => {
    await login();
    const res = await h.app.inject({
      method: "GET",
      url: "/setup/github-app",
      headers: { cookie: `${SETUP_COOKIE}=${randomBytes(32).toString("base64url")}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("setup page", () => {
  it("posts the pinned manifest to GitHub with a fresh state, behind strict headers", async () => {
    const cookie = await login();
    const { res, action, state, manifest } = await page(cookie);
    expect(action).toBe(`https://github.com/settings/apps/new?state=${state}`);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manifest).toStrictEqual(
      buildGitHubAppManifest({
        name: "Rocky Reviews",
        publicUrl: PUBLIC_URL,
        webhookUrl: WEBHOOK_URL,
      }),
    );
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action https://github.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.body).not.toMatch(/<script/i);
    // Each render issues a new state.
    const second = await page(cookie);
    expect(second.state).not.toBe(state);
  });

  it("targets an organization when one is given, and refuses a malformed one", async () => {
    const cookie = await login();
    const { action, state } = await page(cookie, "?org=rocky-reviews");
    expect(action).toBe(
      `https://github.com/organizations/rocky-reviews/settings/apps/new?state=${state}`,
    );
    const bad = await h.app.inject({
      method: "GET",
      url: "/setup/github-app?org=%22%3E%3Cscript%3E",
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("<script>");
  });

  it("refuses to send the human to GitHub when the credentials file already exists", async () => {
    const cookie = await login();
    await import("node:fs/promises").then((fs) => fs.mkdir(join(h.dir, "rocky"), { mode: 0o700 }));
    await writeFile(h.file, "KEEP=1\n", { mode: 0o600 });
    const res = await h.app.inject({
      method: "GET",
      url: "/setup/github-app",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).not.toContain("<form");
    expect(await readFile(h.file, "utf8")).toBe("KEEP=1\n");
  });

  it("refuses to render without an https webhook URL (fail closed, explains what to set)", async () => {
    const noHook = await build({ webhookUrl: undefined });
    try {
      const cookie = await login(noHook);
      const res = await noHook.app.inject({
        method: "GET",
        url: "/setup/github-app",
        headers: { cookie },
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain("GITHUB_APP_WEBHOOK_URL");
      expect(res.body).not.toContain("<form");
    } finally {
      await noHook.app.close();
      await rm(noHook.dir, { recursive: true, force: true });
    }
  });
});

describe("callback", () => {
  it("creates the app: one exchange, credentials file 0600, nothing secret in the page or logs", async () => {
    const body = conversion();
    h.respond = () =>
      new Response(JSON.stringify(body), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    const cookie = await login();
    const { state } = await page(cookie);
    const res = await callback(cookie, `code=${CODE}&state=${state}`);
    expect(res.statusCode).toBe(200);
    expect(h.calls).toStrictEqual([`https://api.github.com/app-manifests/${CODE}/conversions`]);

    const st = await stat(h.file);
    expect(st.mode & 0o777).toBe(0o600);
    const env = parseEnv(await readFile(h.file, "utf8"));
    expect(env["GITHUB_APP_ID"]).toBe("98765");
    expect(env["GITHUB_APP_PRIVATE_KEY"]).toBe(PEM);
    expect(env["GITHUB_APP_CLIENT_SECRET"]).toBe(body.client_secret);
    expect(env["GITHUB_WEBHOOK_SECRET"]).toBe(body.webhook_secret);

    // The page: where the file is and how to install. Deliberately no secret, no id, no code.
    expect(res.body).toContain(h.file);
    expect(res.body).toContain("https://github.com/apps/rocky-reviews-h3/installations/new");
    const everything = res.body + JSON.stringify(res.headers) + h.logs.join("\n");
    for (const secret of [
      body.client_secret,
      body.webhook_secret!,
      body.client_id,
      "PRIVATE KEY",
      PEM.split("\n")[1]!,
      CODE,
      state,
      h.token,
      "98765",
    ]) {
      expect(everything, secret.slice(0, 12)).not.toContain(secret);
    }
    expect(h.logs.join("\n")).toContain('"outcome":"created"');
  });

  it("disables every setup route once the app is created", async () => {
    const cookie = await login();
    const { state } = await page(cookie);
    expect((await callback(cookie, `code=${CODE}&state=${state}`)).statusCode).toBe(200);
    for (const url of [
      "/setup/github-app",
      `/setup/github-app?token=${h.token}`,
      `/setup/github-app/callback?code=${CODE}&state=${state}`,
    ]) {
      const res = await h.app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode, url).toBe(404);
    }
    expect(h.calls).toHaveLength(1);
  });

  it("refuses a callback without the session cookie (no exchange)", async () => {
    const cookie = await login();
    const { state } = await page(cookie);
    const res = await callback(undefined, `code=${CODE}&state=${state}`);
    expect(res.statusCode).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a forged state (no exchange)", async () => {
    const cookie = await login();
    await page(cookie);
    const res = await callback(
      cookie,
      `code=${CODE}&state=${randomBytes(32).toString("base64url")}`,
    );
    expect(res.statusCode).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a valid state presented without the session it was issued to (CSRF / login CSRF)", async () => {
    // Only one session can exist per boot (the token is one-time), so a cross-site attacker can
    // at best replay a stolen state with their own (forged or absent) cookie.
    const cookie = await login();
    const { state } = await page(cookie);
    for (const other of [
      `${SETUP_COOKIE}=${randomBytes(32).toString("base64url")}`,
      `${SETUP_COOKIE}=${tamper(cookie.split("=")[1]!)}`,
      `other=${cookie.split("=")[1]!}`,
    ]) {
      const res = await callback(other, `code=${CODE}&state=${state}`);
      expect(res.statusCode, other).toBe(403);
    }
    expect(h.calls).toHaveLength(0);
    // The rightful session can still use it.
    expect((await callback(cookie, `code=${CODE}&state=${state}`)).statusCode).toBe(200);
  });

  it("refuses an expired state", async () => {
    const cookie = await login();
    const { state } = await page(cookie);
    h.clock.now += SETUP_STATE_TTL_MS + 1;
    const res = await callback(cookie, `code=${CODE}&state=${state}`);
    expect(res.statusCode).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("refuses a replayed state: single use even when the exchange failed", async () => {
    h.respond = () => new Response("{}", { status: 422 });
    const cookie = await login();
    const { state } = await page(cookie);
    expect((await callback(cookie, `code=${CODE}&state=${state}`)).statusCode).toBe(502);
    const replay = await callback(cookie, `code=a${CODE}&state=${state}`);
    expect(replay.statusCode).toBe(403);
    expect(h.calls).toHaveLength(1);
  });

  it("exchanges a code at most once, even with a fresh state", async () => {
    h.respond = () => new Response("{}", { status: 422 });
    const cookie = await login();
    const first = await page(cookie);
    expect((await callback(cookie, `code=${CODE}&state=${first.state}`)).statusCode).toBe(502);
    const second = await page(cookie);
    const res = await callback(cookie, `code=${CODE}&state=${second.state}`);
    expect(res.statusCode).toBe(409);
    expect(h.calls).toHaveLength(1);
  });

  it("runs one exchange at a time (concurrent callbacks → one request to GitHub)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    h.respond = async () => {
      await gate;
      return new Response(JSON.stringify(conversion()), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    };
    const cookie = await login();
    const a = await page(cookie);
    const b = await page(cookie);
    const first = callback(cookie, `code=${CODE}&state=${a.state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await callback(cookie, `code=b${CODE}&state=${b.state}`);
    expect(second.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("refuses missing, repeated or malformed parameters (no exchange)", async () => {
    const cookie = await login();
    const { state } = await page(cookie);
    for (const query of [
      `state=${state}`,
      `code=${CODE}`,
      `code=${CODE}&code=${CODE}&state=${state}`,
      `code=..%2F..%2Fuser&state=${state}`,
      `code=${"a".repeat(200)}&state=${state}`,
      `code=${CODE}&state=${state}&state=${state}`,
    ]) {
      const res = await callback(cookie, query);
      expect(res.statusCode, query).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
    // The state survived malformed attempts that never reached its lookup.
    expect((await callback(cookie, `code=${CODE}&state=${state}`)).statusCode).toBe(200);
  });

  it("answers 502 with the GitHub status only, and writes nothing, on malformed conversions", async () => {
    const cases: [string, () => Response][] = [
      ["500", () => new Response("secret-detail-xyz", { status: 500 })],
      [
        "schema",
        () =>
          new Response(JSON.stringify({ ...conversion(), pem: "nope secret-detail-xyz" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      ],
      [
        "html",
        () =>
          new Response("<b>secret-detail-xyz</b>", {
            status: 201,
            headers: { "content-type": "text/html" },
          }),
      ],
    ];
    for (const [name, respond] of cases) {
      const harness = await build({ respond });
      try {
        const cookie = await login(harness);
        const { state } = await page(cookie, "", harness);
        const res = await callback(cookie, `code=${CODE}&state=${state}`, harness);
        expect(res.statusCode, name).toBe(502);
        expect(res.body + harness.logs.join(""), name).not.toContain("secret-detail-xyz");
        if (name === "500") expect(res.body).toContain("500");
        await expect(stat(harness.file), name).rejects.toMatchObject({ code: "ENOENT" });
        // Setup stays available to try again with a new state.
        expect(
          (
            await harness.app.inject({
              method: "GET",
              url: "/setup/github-app",
              headers: { cookie },
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        await harness.app.close();
        await rm(harness.dir, { recursive: true, force: true });
      }
    }
  });

  it("refuses to save an app created with more than was requested", async () => {
    const body = conversion({
      permissions: { ...conversion().permissions, contents: "write", administration: "write" },
      events: ["pull_request", "push"],
    });
    h.respond = () =>
      new Response(JSON.stringify(body), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    const cookie = await login();
    const { state } = await page(cookie);
    const res = await callback(cookie, `code=${CODE}&state=${state}`);
    expect(res.statusCode).toBe(502);
    expect(res.body).toContain("delete");
    expect(res.body).toContain("https://github.com/settings/apps/rocky-reviews-h3/advanced");
    await expect(stat(h.file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(res.body + h.logs.join("")).not.toContain(body.client_secret);
    expect(h.logs.join("")).toContain("permission:contents");
  });

  it("does not exchange when the credentials file already exists (secrets would be lost)", async () => {
    const cookie = await login();
    const { state } = await page(cookie);
    await import("node:fs/promises").then((fs) => fs.mkdir(join(h.dir, "rocky"), { mode: 0o700 }));
    await writeFile(h.file, "KEEP=1\n", { mode: 0o600 });
    const res = await callback(cookie, `code=${CODE}&state=${state}`);
    expect(res.statusCode).toBe(409);
    expect(h.calls).toHaveLength(0);
    expect(await readFile(h.file, "utf8")).toBe("KEEP=1\n");
  });

  it("generates a strong webhook secret when GitHub's is missing or weak, and says so", async () => {
    for (const webhook_secret of [null, "short"]) {
      const harness = await build({
        respond: () =>
          new Response(JSON.stringify(conversion({ webhook_secret })), {
            status: 201,
            headers: { "content-type": "application/json" },
          }),
      });
      try {
        const cookie = await login(harness);
        const { state } = await page(cookie, "", harness);
        const res = await callback(cookie, `code=${CODE}&state=${state}`, harness);
        expect(res.statusCode).toBe(200);
        const text = await readFile(harness.file, "utf8");
        const env = parseEnv(text);
        expect(env["GITHUB_WEBHOOK_SECRET"]).toMatch(/^[0-9a-f]{64}$/);
        expect(text).toContain("# GITHUB_WEBHOOK_SECRET was generated by Rocky");
        expect(res.body).toContain("Webhook secret");
        expect(res.body).not.toContain(env["GITHUB_WEBHOOK_SECRET"]);
        expect(await readdir(join(harness.dir, "rocky"))).toStrictEqual(["github-app.env"]);
      } finally {
        await harness.app.close();
        await rm(harness.dir, { recursive: true, force: true });
      }
    }
  });
});
