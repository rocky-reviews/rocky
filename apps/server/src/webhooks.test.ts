import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { WebhookDelivery, WebhookInbox } from "@rocky-reviews/core";
import { createGitHubWebhookIngress, signWebhookBody } from "@rocky-reviews/forge-github";
import {
  installationPayload,
  PLANTED,
  pullRequestPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
  type SignedDelivery,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import {
  INBOX_RECORD_TIMEOUT_MS,
  MAX_IN_FLIGHT_BYTES,
  rawBodyParser,
  WEBHOOK_BODY_LIMIT_BYTES,
} from "./webhooks.js";

const URL = "/webhooks/github";

/** In-memory inbox with the same contract as the database one (tests of the HTTP layer). */
const memoryInbox = () => {
  const seen = new Set<string>();
  const recorded: WebhookDelivery[] = [];
  const inbox: WebhookInbox & { recorded: WebhookDelivery[] } = {
    recorded,
    record: vi.fn(async (d: WebhookDelivery) => {
      const keys = [`id:${d.deliveryId}`, `body:${d.payloadSha256}`];
      if (keys.some((k) => seen.has(k))) return "duplicate" as const;
      for (const k of keys) seen.add(k);
      recorded.push(d);
      return "queued" as const;
    }),
  };
  return inbox;
};

const setup = (inbox: WebhookInbox = memoryInbox()) => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger("server-test", {
    destination: {
      write: (c: string) => void lines.push(JSON.parse(c) as Record<string, unknown>),
    },
  });
  const app = buildApp({
    checkDatabase: () => Promise.resolve(true),
    log,
    webhooks: { ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }), inbox },
  });
  return { app, inbox, lines };
};

const post = (app: ReturnType<typeof setup>["app"], d: SignedDelivery) =>
  app.inject({ method: "POST", url: URL, headers: d.headers, payload: d.body });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /webhooks/github: authentication (P3-2)", () => {
  it("answers 401 to a missing or bad signature and records nothing", async () => {
    const { app, inbox } = setup();
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    const unsigned = Object.fromEntries(
      Object.entries(d.headers).filter(([name]) => name !== "x-hub-signature-256"),
    );
    for (const headers of [
      unsigned,
      { ...d.headers, "x-hub-signature-256": "sha256=" + "0".repeat(64) },
      {
        ...d.headers,
        "x-hub-signature-256": signWebhookBody("another-secret-of-sufficient-length!!", d.body),
      },
      {
        ...d.headers,
        "x-hub-signature-256": d.headers["x-hub-signature-256"]!.replace("sha256=", "sha1="),
      },
    ]) {
      const res = await app.inject({ method: "POST", url: URL, headers, payload: d.body });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "unauthenticated" });
    }
    expect(inbox.record).not.toHaveBeenCalled();
  });

  it("checks the signature before parsing: an unsigned invalid JSON body is 401, not 400", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      payload: "{ this is not json",
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a tampered body (one byte changed after signing)", async () => {
    const { app, inbox } = setup();
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    const tampered = Buffer.from(d.body);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 1;
    const res = await post(app, { ...d, body: tampered });
    expect(res.statusCode).toBe(401);
    expect(inbox.record).not.toHaveBeenCalled();
  });

  it("is not registered at all without a webhook configuration", async () => {
    const app = buildApp({ checkDatabase: () => Promise.resolve(true) });
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    expect((await post(app, d)).statusCode).toBe(404);
  });
});

describe("POST /webhooks/github: decoding", () => {
  it("answers 400 for bad headers or payload and 415 for non-JSON bodies, after authentication", async () => {
    const { app, inbox } = setup();
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    expect(
      (await post(app, { ...d, headers: { ...d.headers, "x-github-delivery": "nope" } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post(app, { ...d, headers: { ...d.headers, "content-type": "text/plain" } }))
        .statusCode,
    ).toBe(415);
    const bad = signedDelivery("pull_request", pullRequestPayload("opened", { headSha: "zz" }));
    const res = await post(app, bad);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "bad_payload" });
    expect(inbox.record).not.toHaveBeenCalled();
  });

  it("acknowledges and ignores unknown events and actions without recording them", async () => {
    const { app, inbox } = setup();
    for (const d of [
      signedDelivery("issues", { action: "opened" }),
      signedDelivery("push", { ref: "refs/heads/main" }),
      signedDelivery("pull_request", pullRequestPayload("labeled")),
      signedDelivery("installation", installationPayload("suspend")),
    ]) {
      const res = await post(app, d);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "ignored" });
    }
    expect(inbox.record).not.toHaveBeenCalled();
  });

  it("answers ping with 200", async () => {
    const { app } = setup();
    const res = await post(app, signedDelivery("ping", { zen: "Design for failure.", hook_id: 1 }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "pong" });
  });
});

describe("POST /webhooks/github: enqueue and idempotency", () => {
  it("records an accepted delivery and answers 202; the same delivery again is 200 duplicate", async () => {
    const { app, inbox } = setup();
    const d = signedDelivery("installation", installationPayload("created"));
    const first = await post(app, d);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({ status: "queued" });
    const again = await post(app, d);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: "duplicate" });
    const memory = inbox as ReturnType<typeof memoryInbox>;
    expect(memory.recorded).toHaveLength(1);
    expect(memory.recorded[0]).toMatchObject({
      forge: "github",
      deliveryId: d.headers["x-github-delivery"],
      event: { type: "installation.created", installationId: 4242 },
    });
  });

  it("treats a signed body replayed under a new delivery id as a duplicate", async () => {
    const { app } = setup();
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    expect((await post(app, d)).statusCode).toBe(202);
    const replay = { ...d, headers: { ...d.headers, "x-github-delivery": randomUUID() } };
    expect((await post(app, replay)).statusCode).toBe(200);
  });

  it("answers 503 when the inbox is unavailable, logging only the error code", async () => {
    const failing: WebhookInbox = {
      record: () =>
        Promise.reject(
          Object.assign(new Error(`Failing row contains (${PLANTED.title})`), { code: "57P01" }),
        ),
    };
    const { app, lines } = setup(failing);
    const res = await post(app, signedDelivery("pull_request", pullRequestPayload("opened")));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "unavailable" });
    const entry = lines.find((l) => l["msg"] === "webhook inbox unavailable");
    expect(entry?.["webhook"]).toMatchObject({ outcome: "inbox_error", sqlstate: "57P01" });
    expect(JSON.stringify(lines)).not.toContain(PLANTED.title);
  });

  it("does no forge I/O in the request path", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network here"));
    const { app } = setup();
    for (const d of [
      signedDelivery("installation", installationPayload("deleted")),
      signedDelivery("pull_request", pullRequestPayload("synchronize")),
    ]) {
      expect((await post(app, d)).statusCode).toBe(202);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("POST /webhooks/github: limits and logs", () => {
  it("refuses bodies over the limit with 413 and accepts a large one under it", async () => {
    const { app, inbox } = setup();
    const big = pullRequestPayload("opened");
    (big["pull_request"] as Record<string, unknown>)["body"] = "x".repeat(
      WEBHOOK_BODY_LIMIT_BYTES - 4096,
    );
    const ok = signedDelivery("pull_request", big);
    expect(ok.body.length).toBeLessThan(WEBHOOK_BODY_LIMIT_BYTES);
    expect((await post(app, ok)).statusCode).toBe(202);

    (big["pull_request"] as Record<string, unknown>)["body"] = "x".repeat(WEBHOOK_BODY_LIMIT_BYTES);
    const tooBig = signedDelivery("pull_request", big);
    const res = await post(app, tooBig);
    expect(res.statusCode).toBe(413);
    expect(inbox.record).toHaveBeenCalledTimes(1);
  });

  it("never logs the body, signature, secret or payload content", async () => {
    const { app, lines } = setup();
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    await post(app, d);
    await post(app, {
      ...d,
      headers: { ...d.headers, "x-hub-signature-256": "sha256=" + "1".repeat(64) },
    });
    await post(
      app,
      signedDelivery("installation", installationPayload("created", { login: "secret-org-login" })),
    );
    const text = JSON.stringify(lines);
    for (const forbidden of [
      d.headers["x-hub-signature-256"]!.slice(7),
      "1".repeat(64),
      TEST_WEBHOOK_SECRET,
      PLANTED.title,
      PLANTED.body.slice(0, 20),
      PLANTED.email,
      "secret-org-login",
      "acme/api",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    const queued = lines.find((l) => l["msg"] === "webhook queued");
    expect(queued?.["webhook"]).toMatchObject({
      forge: "github",
      outcome: "queued",
      deliveryId: d.headers["x-github-delivery"],
      eventType: "pull_request.opened",
      bytes: d.body.length,
    });
    const rejected = lines.find((l) => l["msg"] === "webhook rejected");
    expect(rejected?.["webhook"]).toEqual({
      forge: "github",
      outcome: "rejected",
      reason: "unauthenticated",
      bytes: d.body.length,
    });
  });

  it("leaves JSON parsing on other routes untouched", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});

describe("POST /webhooks/github under fuzzing (no 5xx)", () => {
  const SEED = 20261026;

  it("random headers and bodies never produce a 5xx and never reach the inbox unsigned", async () => {
    const { app, inbox } = setup();
    const headerName = fc.constantFrom(
      "content-type",
      "x-github-event",
      "x-github-delivery",
      "x-hub-signature-256",
      "content-encoding",
      "transfer-encoding",
      "x-other",
    );
    const headerValue = fc.oneof(
      fc.string({ maxLength: 120 }).filter((v) => /^[\t\x20-\x7e]*$/.test(v)),
      fc.constantFrom(
        "application/json",
        "sha256=" + "0".repeat(64),
        randomUUID(),
        "pull_request",
        "gzip",
      ),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(headerName, headerValue, { maxKeys: 6 }),
        fc.oneof(
          fc.uint8Array({ maxLength: 4096 }),
          fc.jsonValue().map((v) => Buffer.from(JSON.stringify(v) ?? "")),
        ),
        async (headers, body) => {
          const res = await app.inject({
            method: "POST",
            url: URL,
            headers,
            payload: Buffer.from(body),
          });
          expect(res.statusCode).toBeLessThan(500);
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
    expect(inbox.record).not.toHaveBeenCalled();
  });

  it("signed random and mutated payloads never produce a 5xx", async () => {
    const { app } = setup();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("installation", "pull_request", "ping", "issues"),
        fc.oneof(
          fc.jsonValue({ maxDepth: 5 }),
          fc.constantFrom(pullRequestPayload("opened"), installationPayload("created")).chain((p) =>
            fc
              .record({
                key: fc.constantFrom(...Object.keys(p)),
                value: fc.jsonValue({ maxDepth: 3 }),
              })
              .map(({ key, value }) => ({ ...p, [key]: value })),
          ),
        ),
        async (event, payload) => {
          const res = await post(app, signedDelivery(event, payload));
          expect(res.statusCode).toBeLessThan(500);
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });
});

describe("review round 1", () => {
  it("item 2: answers 503 when the inbox never settles, within the 6 s guard (GitHub waits 10 s)", async () => {
    const hanging: WebhookInbox = { record: () => new Promise(() => undefined) };
    const { app, lines } = setup(hanging);
    const started = Date.now();
    const res = await post(app, signedDelivery("pull_request", pullRequestPayload("opened")));
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "unavailable" });
    expect(INBOX_RECORD_TIMEOUT_MS).toBe(6_000);
    expect(elapsed).toBeGreaterThanOrEqual(INBOX_RECORD_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(8_000);
    const entry = lines.find((l) => l["msg"] === "webhook inbox unavailable");
    expect(entry?.["webhook"]).toMatchObject({ outcome: "inbox_timeout", timeoutMs: 6_000 });
  }, 15_000);

  it("item 2: the guard is per request and leaves a fast inbox alone", async () => {
    let calls = 0;
    const inbox: WebhookInbox = {
      record: () => (++calls === 1 ? new Promise(() => undefined) : Promise.resolve("queued")),
    };
    const app = buildApp({
      checkDatabase: () => Promise.resolve(true),
      webhooks: {
        ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }),
        inbox,
        recordTimeoutMs: 50,
      },
    });
    const first = await post(app, signedDelivery("pull_request", pullRequestPayload("opened")));
    expect(first.statusCode).toBe(503);
    const second = await post(app, signedDelivery("pull_request", pullRequestPayload("closed")));
    expect(second.statusCode).toBe(202);
  });

  it("item 3: the limit is GitHub's 25 MB cap, and a large installation.created is accepted", async () => {
    expect(WEBHOOK_BODY_LIMIT_BYTES).toBe(25 * 1024 * 1024);
    const { app, inbox } = setup();
    const payload = installationPayload("created");
    payload["repositories"] = Array.from({ length: 60_000 }, (_, i) => ({
      id: i + 1,
      node_id: `R_kgDO${String(i).padStart(8, "0")}`,
      name: `repository-${i}`,
      full_name: `acme/repository-${i}`,
      private: true,
    }));
    const d = signedDelivery("installation", payload);
    expect(d.body.length).toBeGreaterThan(6 * 1024 * 1024);
    expect((await post(app, d)).statusCode).toBe(202);
    expect(inbox.record).toHaveBeenCalledTimes(1);
  });

  it("item 8: opens no network connection of any kind in the request path", async () => {
    const blocked = () => {
      throw new Error("network access in the webhook request path");
    };
    const spies = [
      vi.spyOn(globalThis, "fetch").mockImplementation(blocked),
      vi.spyOn(http, "request").mockImplementation(blocked),
      vi.spyOn(http, "get").mockImplementation(blocked),
      vi.spyOn(https, "request").mockImplementation(blocked),
      vi.spyOn(https, "get").mockImplementation(blocked),
      vi.spyOn(net.Socket.prototype, "connect").mockImplementation(blocked),
      vi.spyOn(net, "connect").mockImplementation(blocked),
      vi.spyOn(net, "createConnection").mockImplementation(blocked),
    ];
    const { app } = setup();
    for (const d of [
      signedDelivery("installation", installationPayload("created")),
      signedDelivery("installation", installationPayload("deleted")),
      signedDelivery("pull_request", pullRequestPayload("synchronize")),
      signedDelivery("pull_request", pullRequestPayload("labeled")),
      signedDelivery("ping", { zen: "Speak like a human.", hook_id: 1 }),
    ]) {
      expect((await post(app, d)).statusCode).toBeLessThan(300);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // Positive control (review round 2, N3): the blocks are live, so a connection attempt from
    // the request path would have thrown and failed the request above.
    expect(() => net.connect({ port: 1, host: "127.0.0.1" })).toThrow(/network access/);
    expect(() => http.request("http://127.0.0.1:1/")).toThrow(/network access/);
  });

  it("item 7: logs the reason when an unsupported account type is ignored", async () => {
    const { app, inbox, lines } = setup();
    const d = signedDelivery(
      "installation",
      installationPayload("created", { type: "Enterprise" }),
    );
    const res = await post(app, d);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ignored" });
    expect(inbox.record).not.toHaveBeenCalled();
    expect(lines.find((l) => l["msg"] === "webhook ignored")?.["webhook"]).toMatchObject({
      outcome: "ignored",
      eventName: "installation",
      reason: "unsupported_account_type",
    });
  });
});

describe("review round 2, S1: memory exposure to unauthenticated clients", () => {
  const big = Buffer.alloc(WEBHOOK_BODY_LIMIT_BYTES, 0x7b);

  it("refuses a 25 MiB body with no or a malformed signature before reading it", async () => {
    const parse = vi.spyOn(rawBodyParser, "parse");
    const { app, inbox, lines } = setup();
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    const unsigned = Object.fromEntries(
      Object.entries(d.headers).filter(([name]) => name !== "x-hub-signature-256"),
    );
    for (const [headers, status, reason] of [
      [unsigned, 401, "unauthenticated"],
      [{ ...d.headers, "x-hub-signature-256": "sha256=nothex" }, 401, "unauthenticated"],
      [{ ...d.headers, "x-hub-signature-256": "sha1=" + "0".repeat(40) }, 401, "unauthenticated"],
      [{ ...d.headers, "x-github-delivery": "not-a-guid" }, 400, "bad_headers"],
      [{ ...d.headers, "content-type": "text/plain" }, 415, "unsupported_media_type"],
    ] as const) {
      const res = await app.inject({ method: "POST", url: URL, headers, payload: big });
      expect(res.statusCode, reason).toBe(status);
      expect(res.json()).toEqual({ error: reason });
    }
    expect(parse).not.toHaveBeenCalled();
    expect(inbox.record).not.toHaveBeenCalled();
    expect(lines.filter((l) => l["msg"] === "webhook rejected").map((l) => l["webhook"])).toEqual(
      Array.from({ length: 5 }, () => expect.objectContaining({ stage: "precheck" })),
    );
    // Control: a well-formed request does reach the parser.
    expect((await post(app, d)).statusCode).toBe(202);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("answers 503 beyond the in-flight byte budget, and frees the budget afterwards", async () => {
    expect(MAX_IN_FLIGHT_BYTES).toBe(64 * 1024 * 1024);
    const first = signedDelivery("pull_request", pullRequestPayload("opened", { number: 1 }));
    let resolveFirst: (v: "queued") => void = () => undefined;
    let calls = 0;
    const inbox: WebhookInbox = {
      record: () =>
        ++calls === 1
          ? new Promise((resolve) => (resolveFirst = resolve))
          : Promise.resolve("queued"),
    };
    const { log, lines } = (() => {
      const captured: Record<string, unknown>[] = [];
      return {
        lines: captured,
        log: createLogger("server-test", {
          destination: {
            write: (c: string) => void captured.push(JSON.parse(c) as Record<string, unknown>),
          },
        }),
      };
    })();
    const app = buildApp({
      checkDatabase: () => Promise.resolve(true),
      log,
      webhooks: {
        ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }),
        inbox,
        maxInFlightBytes: Math.floor(first.body.length * 1.5),
      },
    });
    const pending = post(app, first);
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await post(
      app,
      signedDelivery("pull_request", pullRequestPayload("opened", { number: 2 })),
    );
    expect(second.statusCode).toBe(503);
    expect(second.json()).toEqual({ error: "overloaded" });
    expect(
      lines.find((l) => l["msg"]?.toString().startsWith("webhook refused"))?.["webhook"],
    ).toMatchObject({
      outcome: "overloaded",
    });
    resolveFirst("queued");
    expect((await pending).statusCode).toBe(202);
    const third = await post(
      app,
      signedDelivery("pull_request", pullRequestPayload("opened", { number: 3 })),
    );
    expect(third.statusCode).toBe(202);
    // Rejections free their reservation too: many in a row never exhaust the budget.
    for (let i = 0; i < 5; i++) {
      const bad = signedDelivery("pull_request", pullRequestPayload("opened", { headSha: "zz" }));
      expect((await post(app, bad)).statusCode).toBe(400);
    }
    expect(
      (await post(app, signedDelivery("pull_request", pullRequestPayload("opened", { number: 4 }))))
        .statusCode,
    ).toBe(202);
  });

  it("cuts off a slow upload at the request timeout", async () => {
    const app = buildApp({
      checkDatabase: () => Promise.resolve(true),
      webhooks: {
        ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }),
        inbox: memoryInbox(),
      },
      requestTimeoutMs: 500,
      timeoutCheckIntervalMs: 100,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as net.AddressInfo;
      const d = signedDelivery("pull_request", pullRequestPayload("opened"));
      const socket = net.connect({ port, host: "127.0.0.1" });
      const started = Date.now();
      const received: Buffer[] = [];
      socket.on("data", (c: Buffer) => received.push(c));
      // The server resets the connection when it times the request out; a trickle write racing
      // that reset raises EPIPE/ECONNRESET on this client socket, which is expected here.
      const socketErrors: string[] = [];
      socket.on("error", (error: NodeJS.ErrnoException) => socketErrors.push(error.code ?? "?"));
      socket.write(
        [
          `POST ${URL} HTTP/1.1`,
          "host: 127.0.0.1",
          ...Object.entries(d.headers).map(([k, v]) => `${k}: ${v}`),
          "content-length: 1000000",
          "",
          "",
        ].join("\r\n"),
      );
      // Trickle: one byte every 50 ms, far slower than the 1 MB announced.
      const trickle = setInterval(() => {
        if (socket.writable) socket.write("x");
      }, 50);
      const closed = new Promise<void>((resolve) =>
        socket.on("close", () => {
          clearInterval(trickle);
          resolve();
        }),
      );
      await closed;
      for (const code of socketErrors) expect(["EPIPE", "ECONNRESET"]).toContain(code);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(3_000);
      expect(Buffer.concat(received).toString("latin1")).toMatch(/^HTTP\/1\.1 408/);
    } finally {
      await app.close();
    }
  }, 10_000);
});

describe("review round 3, S-B: the budget counts bytes actually received", () => {
  const listening = async (deps: { maxInFlightBytes: number; requestTimeoutMs?: number }) => {
    const app = buildApp({
      checkDatabase: () => Promise.resolve(true),
      webhooks: {
        ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }),
        inbox: memoryInbox(),
        maxInFlightBytes: deps.maxInFlightBytes,
      },
      ...(deps.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: deps.requestTimeoutMs, timeoutCheckIntervalMs: 100 }),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as net.AddressInfo;
    return { app, port };
  };

  /** A client with well-formed (forged) headers that announces `declared` bytes and trickles. */
  const slowClient = (port: number, declared: number) => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.on("error", () => undefined); // reset by the server on timeout or close: expected
    const received: Buffer[] = [];
    socket.on("data", (c: Buffer) => received.push(c));
    socket.write(
      [
        `POST ${URL} HTTP/1.1`,
        "host: 127.0.0.1",
        ...Object.entries(d.headers).map(
          ([k, v]) => `${k}: ${k === "x-hub-signature-256" ? "sha256=" + "0".repeat(64) : v}`,
        ),
        `content-length: ${declared}`,
        "",
        "",
      ].join("\r\n"),
    );
    const trickle = setInterval(() => {
      if (socket.writable) socket.write("x");
    }, 50);
    const closed = new Promise<void>((resolve) =>
      socket.on("close", () => {
        clearInterval(trickle);
        resolve();
      }),
    );
    return {
      closed,
      response: () => Buffer.concat(received).toString("latin1"),
      stop: () => {
        clearInterval(trickle);
        socket.destroy();
      },
    };
  };

  const deliver = async (port: number, d: SignedDelivery) => {
    const res = await fetch(`http://127.0.0.1:${port}${URL}`, {
      method: "POST",
      headers: d.headers,
      body: d.body,
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  it("slow clients that announce big bodies but trickle do not crowd out a genuine delivery", async () => {
    const budget = 4 * 1024 * 1024;
    const { app, port } = await listening({ maxInFlightBytes: budget });
    // Together they announce the whole budget (the round-2 code reserved it and answered 503).
    const liars = [slowClient(port, budget / 2), slowClient(port, budget / 2)];
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const res = await deliver(port, signedDelivery("pull_request", pullRequestPayload("opened")));
      expect(res).toEqual({ status: 202, body: { status: "queued" } });
    } finally {
      for (const liar of liars) liar.stop();
      await app.close();
    }
  });

  it("answers 503 when the bytes actually sent overflow the budget (chunked, nothing declared)", async () => {
    const { app, port } = await listening({ maxInFlightBytes: 4096 });
    try {
      const d = signedDelivery("pull_request", pullRequestPayload("opened"));
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.on("error", () => undefined);
      const received: Buffer[] = [];
      socket.on("data", (c: Buffer) => received.push(c));
      const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
      socket.write(
        [
          `POST ${URL} HTTP/1.1`,
          "host: 127.0.0.1",
          "connection: close",
          ...Object.entries(d.headers).map(([k, v]) => `${k}: ${v}`),
          "transfer-encoding: chunked",
          "",
          "",
        ].join("\r\n"),
      );
      const chunk = Buffer.alloc(1024, 0x20);
      for (let i = 0; i < 16 && socket.writable; i++) {
        socket.write(`${chunk.length.toString(16)}\r\n`);
        socket.write(chunk);
        socket.write("\r\n");
      }
      if (socket.writable) socket.write("0\r\n\r\n");
      await closed;
      const text = Buffer.concat(received).toString("latin1");
      expect(text).toMatch(/^HTTP\/1\.1 503/);
      expect(text).toContain('{"error":"overloaded"}');
      // The overflowing request's bytes were released: a delivery that fits gets through.
      expect((await deliver(port, d)).status).toBe(202);
    } finally {
      await app.close();
    }
  });

  it("frees the budget after a 408: with room for exactly one body, the next delivery gets 202", async () => {
    const d = signedDelivery("pull_request", pullRequestPayload("opened"));
    const { app, port } = await listening({
      maxInFlightBytes: d.body.length,
      requestTimeoutMs: 500,
    });
    try {
      const slow = slowClient(port, d.body.length);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // While the slow client holds part of the budget, a full-size body does not fit.
      expect((await deliver(port, d)).status).toBe(503);
      await slow.closed;
      expect(slow.response()).toMatch(/^HTTP\/1\.1 408/);
      // Same size as `d` (only the PR number differs), so it needs the whole budget.
      const next = signedDelivery("pull_request", pullRequestPayload("opened", { number: 848 }));
      expect(next.body.length).toBe(d.body.length);
      const res = await deliver(port, next);
      expect(res).toEqual({ status: 202, body: { status: "queued" } });
    } finally {
      await app.close();
    }
  }, 10_000);
});
