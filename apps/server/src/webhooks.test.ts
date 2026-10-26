import { randomUUID } from "node:crypto";
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
import { WEBHOOK_BODY_LIMIT_BYTES } from "./webhooks.js";

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
