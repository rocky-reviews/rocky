import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGitHubAppManifest,
  convertManifestCode,
  GITHUB_APP_EVENTS,
  GITHUB_APP_PERMISSIONS,
  githubEndpoints,
  isManifestCode,
  manifestFormAction,
  ManifestConversionError,
  MANIFEST_CONVERSION_TIMEOUT_MS,
  usableWebhookSecret,
  widenedGrants,
} from "./app-manifest.js";
import { MIN_WEBHOOK_SECRET_LENGTH } from "./signature.js";

const PUBLIC_URL = new URL("https://rocky.example.com");
const WEBHOOK_URL = new URL("https://smee.io/abcDEF123");

describe("GitHub App manifest (P3-1)", () => {
  it("is pinned exactly: permissions, events, public, URLs, hook_attributes (any widening fails)", () => {
    expect(
      buildGitHubAppManifest({
        name: "Rocky Reviews",
        publicUrl: PUBLIC_URL,
        webhookUrl: WEBHOOK_URL,
      }),
    ).toStrictEqual({
      name: "Rocky Reviews",
      url: "https://rocky.example.com/",
      description:
        "Rocky Reviews (self-hosted): AI does the reading, a human makes the call. Only a person posts reviews.",
      hook_attributes: { url: "https://smee.io/abcDEF123", active: true },
      redirect_url: "https://rocky.example.com/setup/github-app/callback",
      callback_urls: ["https://rocky.example.com/auth/github/callback"],
      public: false,
      default_events: ["pull_request"],
      default_permissions: {
        contents: "read",
        pull_requests: "write",
        checks: "read",
        metadata: "read",
      },
      request_oauth_on_install: false,
      setup_on_update: false,
    });
  });

  it("requests exactly the four permissions of the plan and one event", () => {
    expect(GITHUB_APP_PERMISSIONS).toStrictEqual({
      contents: "read",
      pull_requests: "write",
      checks: "read",
      metadata: "read",
    });
    expect(GITHUB_APP_EVENTS).toStrictEqual(["pull_request"]);
    expect(Object.isFrozen(GITHUB_APP_PERMISSIONS)).toBe(true);
    expect(Object.isFrozen(GITHUB_APP_EVENTS)).toBe(true);
  });

  it("serialises to JSON with no setup_url and no extra keys", () => {
    const json = JSON.stringify(
      buildGitHubAppManifest({ name: "R", publicUrl: PUBLIC_URL, webhookUrl: WEBHOOK_URL }),
    );
    expect(json).not.toContain("setup_url");
    expect(Object.keys(JSON.parse(json) as object)).toHaveLength(11);
  });

  it("refuses a webhook URL that is not https, and app names GitHub would refuse", () => {
    expect(() =>
      buildGitHubAppManifest({
        name: "R",
        publicUrl: PUBLIC_URL,
        webhookUrl: new URL("http://smee.io/x"),
      }),
    ).toThrow(/https/);
    for (const name of ["", "x".repeat(35), "<script>", "a\nb"]) {
      expect(() =>
        buildGitHubAppManifest({ name, publicUrl: PUBLIC_URL, webhookUrl: WEBHOOK_URL }),
      ).toThrow(/name/);
    }
  });

  it("builds the form action for a personal account and for an organization, with state", () => {
    const endpoints = githubEndpoints({});
    const state = "st4te_0123456789-abcdefghijklmnopqrstuvwx";
    expect(manifestFormAction(endpoints, state)).toBe(
      `https://github.com/settings/apps/new?state=${state}`,
    );
    expect(manifestFormAction(endpoints, state, "rocky-reviews")).toBe(
      `https://github.com/organizations/rocky-reviews/settings/apps/new?state=${state}`,
    );
    for (const org of ["../evil", "-x", "x-", "a--b".repeat(20), "evil.example"]) {
      expect(() => manifestFormAction(endpoints, state, org), org).toThrow(/organization/);
    }
    expect(() => manifestFormAction(endpoints, "short")).toThrow(/state/);
    expect(() => manifestFormAction(endpoints, "a&b=c")).toThrow(/state/);
  });
});

describe("githubEndpoints", () => {
  it("defaults to github.com and api.github.com", () => {
    const e = githubEndpoints({});
    expect(e.web.href).toBe("https://github.com/");
    expect(e.api.href).toBe("https://api.github.com/");
  });

  it("derives the GHES API base and accepts an explicit one", () => {
    expect(githubEndpoints({ webUrl: "https://ghe.corp.example" }).api.href).toBe(
      "https://ghe.corp.example/api/v3/",
    );
    expect(
      githubEndpoints({
        webUrl: "https://ghe.corp.example",
        apiUrl: "https://ghe.corp.example/api/v3",
      }).api.href,
    ).toBe("https://ghe.corp.example/api/v3/");
  });

  it("refuses non-https, credentials, query, fragment and odd paths (fail closed)", () => {
    for (const webUrl of [
      "http://github.com",
      "https://user:pw@github.com",
      "https://github.com/?x=1",
      "https://github.com/#x",
      "https://github.com/some/path",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(() => githubEndpoints({ webUrl }), webUrl).toThrow();
    }
    expect(() => githubEndpoints({ apiUrl: "http://api.github.com" })).toThrow();
    expect(() => githubEndpoints({ apiUrl: "https://api.github.com/repos" })).toThrow();
  });
});

describe("isManifestCode", () => {
  it("accepts GitHub-shaped codes only (no path or query injection)", () => {
    expect(isManifestCode("a1b2c3d4e5f60718293a")).toBe(true);
    for (const bad of ["", "../x", "a/b", "a?b", "a b", "a%2F", "x".repeat(129), 7]) {
      expect(isManifestCode(bad)).toBe(false);
    }
  });
});

const rsaPem = (bits = 2048): string =>
  generateKeyPairSync("rsa", { modulusLength: bits }).privateKey.export({
    type: "pkcs1",
    format: "pem",
  }) as string;

const PEM = rsaPem();

/** A conversion response shaped like GitHub's (synthetic values, generated at run time). */
const conversionBody = (overrides: Record<string, unknown> = {}) => ({
  id: 123456,
  slug: "rocky-reviews-test",
  node_id: "A_kwDOAAAA",
  name: "Rocky Reviews test",
  description: "x",
  external_url: "https://rocky.example.com",
  html_url: "https://github.com/apps/rocky-reviews-test",
  created_at: "2026-10-26T00:00:00Z",
  updated_at: "2026-10-26T00:00:00Z",
  owner: { login: "rocky-reviews", id: 1, type: "Organization" },
  permissions: { contents: "read", pull_requests: "write", checks: "read", metadata: "read" },
  events: ["pull_request"],
  client_id: "Iv23liABCDEF12345678",
  client_secret: randomBytes(20).toString("hex"),
  webhook_secret: randomBytes(20).toString("hex"),
  pem: PEM,
  ...overrides,
});

type FetchCall = { url: string; init: RequestInit };

const fakeFetch = (
  respond: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as typeof fetch, calls };
};

const json = (status: number, body: unknown, contentType = "application/json; charset=utf-8") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });

describe("convertManifestCode", () => {
  const api = githubEndpoints({}).api;

  it("POSTs to api.github.com/app-manifests/{code}/conversions, no redirects, with a timeout", async () => {
    const body = conversionBody();
    const { fetch, calls } = fakeFetch(() => json(201, body));
    const result = await convertManifestCode({ api, code: "abc123", fetch });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.github.com/app-manifests/abc123/conversions");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("authorization")).toBeNull();
    expect(result).toStrictEqual({
      appId: 123456,
      slug: "rocky-reviews-test",
      clientId: body.client_id,
      clientSecret: body.client_secret,
      privateKeyPem: PEM,
      webhookSecret: body.webhook_secret,
      permissions: body.permissions,
      events: body.events,
    });
  });

  it("uses a GHES API base", async () => {
    const ghes = githubEndpoints({ webUrl: "https://ghe.corp.example" }).api;
    const { fetch, calls } = fakeFetch(() => json(201, conversionBody()));
    await convertManifestCode({ api: ghes, code: "abc", fetch });
    expect(calls[0]!.url).toBe("https://ghe.corp.example/api/v3/app-manifests/abc/conversions");
  });

  it("refuses a malformed code before any request", async () => {
    const { fetch, calls } = fakeFetch(() => json(201, conversionBody()));
    await expect(convertManifestCode({ api, code: "../../user", fetch })).rejects.toMatchObject({
      reason: "invalid_code",
    });
    expect(calls).toHaveLength(0);
  });

  it("reduces HTTP errors to the status code only (the body never reaches the error)", async () => {
    for (const status of [404, 422, 500, 200]) {
      const { fetch } = fakeFetch(() =>
        json(status, { message: "Bad code abc123 leaked-secret-xyz", documentation_url: "u" }),
      );
      const error = await convertManifestCode({ api, code: "abc123", fetch }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ManifestConversionError);
      expect(error).toMatchObject({ reason: "http_status", status });
      expect(JSON.stringify(error) + String(error) + (error as Error).stack).not.toMatch(
        /leaked|abc123/,
      );
    }
  });

  it("maps a timeout and network failures (including redirects) to fixed reasons", async () => {
    const hang = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(
      convertManifestCode({ api, code: "abc", fetch: hang.fetch, timeoutMs: 20 }),
    ).rejects.toMatchObject({ reason: "timeout" });
    expect(MANIFEST_CONVERSION_TIMEOUT_MS).toBeLessThanOrEqual(15_000);

    const broken = fakeFetch(() => Promise.reject(new TypeError("fetch failed: redirect")));
    await expect(
      convertManifestCode({ api, code: "abc", fetch: broken.fetch }),
    ).rejects.toMatchObject({ reason: "network" });
  });

  it("refuses responses that are not JSON, too large, or fail the schema", async () => {
    const cases: [string, Response][] = [
      ["html", new Response("<html>", { status: 201, headers: { "content-type": "text/html" } })],
      [
        "bad json",
        new Response("{", { status: 201, headers: { "content-type": "application/json" } }),
      ],
      [
        "huge",
        new Response(JSON.stringify({ pad: "x".repeat(300 * 1024) }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ],
      ["array", json(201, [])],
      ["no pem", json(201, conversionBody({ pem: undefined }))],
      ["id string", json(201, conversionBody({ id: "1" }))],
      ["id zero", json(201, conversionBody({ id: 0 }))],
      ["slug injection", json(201, conversionBody({ slug: "x\nNODE_OPTIONS=--require=/tmp/x" }))],
      ["client id quote", json(201, conversionBody({ client_id: 'Iv1."x' }))],
      [
        "client secret newline",
        json(201, conversionBody({ client_secret: "a".repeat(40) + "\nX=1" })),
      ],
      ["client secret short", json(201, conversionBody({ client_secret: "abc" }))],
      [
        "pem garbage",
        json(
          201,
          conversionBody({
            pem: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
          }),
        ),
      ],
      ["pem small key", json(201, conversionBody({ pem: rsaPem(1024) }))],
      ["pem trailing line", json(201, conversionBody({ pem: PEM + "X=1\n" }))],
      ["permissions not object", json(201, conversionBody({ permissions: "all" }))],
      ["events not array", json(201, conversionBody({ events: "push" }))],
    ];
    for (const [name, response] of cases) {
      const { fetch } = fakeFetch(() => response);
      const error = await convertManifestCode({ api, code: "abc", fetch }).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(ManifestConversionError);
      expect((error as ManifestConversionError).reason, name).toBe("invalid_response");
      expect((error as Error).message, name).not.toMatch(/PRIVATE|NODE_OPTIONS/);
    }
  });

  it("accepts a null webhook secret (GitHub documents it as nullable)", async () => {
    const { fetch } = fakeFetch(() => json(201, conversionBody({ webhook_secret: null })));
    const result = await convertManifestCode({ api, code: "abc", fetch });
    expect(result.webhookSecret).toBeNull();
  });
});

describe("widenedGrants", () => {
  it("is empty when GitHub granted what was requested, or less", () => {
    expect(widenedGrants(GITHUB_APP_PERMISSIONS, ["pull_request"])).toStrictEqual([]);
    expect(widenedGrants({ metadata: "read" }, [])).toStrictEqual([]);
    expect(widenedGrants({ pull_requests: "read" }, [])).toStrictEqual([]);
  });

  it("names every widened permission or event", () => {
    expect(
      widenedGrants(
        { ...GITHUB_APP_PERMISSIONS, contents: "write", administration: "read", checks: "admin" },
        ["pull_request", "push"],
      ),
    ).toStrictEqual([
      "permission:contents",
      "permission:checks",
      "permission:administration",
      "event:push",
    ]);
    expect(widenedGrants({ metadata: "weird" }, [])).toStrictEqual(["permission:metadata"]);
    expect(
      widenedGrants(JSON.parse('{"__proto__":"read"}') as Record<string, string>, []),
    ).toStrictEqual(["permission:__proto__"]);
  });
});

describe("usableWebhookSecret", () => {
  it("keeps GitHub's secret when it is strong and plain ASCII", () => {
    const s = randomBytes(20).toString("hex");
    expect(usableWebhookSecret(s)).toBe(s);
  });

  it("refuses null, short, padded or non-printable secrets (caller generates one)", () => {
    for (const bad of [
      null,
      "",
      "x".repeat(MIN_WEBHOOK_SECRET_LENGTH - 1),
      ` ${"x".repeat(40)}`,
      `${"x".repeat(40)}\n`,
      `${"x".repeat(40)}"`,
      `${"x".repeat(40)}$`,
      `${"x".repeat(40)}é`,
    ]) {
      expect(usableWebhookSecret(bad), String(bad)).toBeUndefined();
    }
  });
});
