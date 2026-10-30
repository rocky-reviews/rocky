import type { WebhookDelivery, WebhookInbox } from "@rocky-reviews/core";
import { createGitHubWebhookIngress } from "@rocky-reviews/forge-github";
import {
  pullRequestPayload,
  signedDelivery,
  TEST_APP_ID,
  TEST_WEBHOOK_SECRET,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createRateLimits, DEFAULT_RATE_LIMITS } from "./security/rate-limit.js";
import { webhookRateLimit } from "./security/route-limits.js";
import { rawBodyParser, WEBHOOK_BODY_LIMIT_BYTES } from "./webhooks.js";

/**
 * P7-3 (ADR 0025): webhook floods. A per-source budget of rejections is checked before the body
 * is read and spent only by rejections (bad precheck, bad signature, oversized body); genuine
 * deliveries never spend it, and another app's deliveries from GitHub's shared addresses fill a
 * separate bucket. A per-installation budget is checked after the signature holds and spent only
 * by deliveries the inbox queued, so neither forged nor replayed deliveries use it up.
 */

const URL = "/webhooks/github";

const setup = (rules: { ip: number; installation: number }) => {
  const lines: string[] = [];
  const log = createLogger("webhook-limit-test", {
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  const recorded: WebhookDelivery[] = [];
  const seen = new Set<string>();
  // Dedups by delivery id, like the real inbox.
  const inbox: WebhookInbox = {
    record: vi.fn(async (d: WebhookDelivery) => {
      if (seen.has(d.deliveryId)) return "duplicate" as const;
      seen.add(d.deliveryId);
      recorded.push(d);
      return "queued" as const;
    }),
  };
  const limits = createRateLimits({
    rules: {
      ...DEFAULT_RATE_LIMITS,
      "webhook.ip": { max: rules.ip, windowMs: 60_000 },
      "webhook.installation": { max: rules.installation, windowMs: 60_000 },
    },
    trustProxy: { kind: "none" },
  });
  const app = buildApp({
    checkDatabase: () => Promise.resolve(true),
    log,
    webhooks: {
      ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET, appId: TEST_APP_ID }),
      inbox,
      rateLimit: webhookRateLimit(limits),
    },
  });
  return { app, recorded, inbox, lines };
};

const ATTACKER_SECRET = "attacker-secret-that-is-long-enough-000000";

let n = 0;
const delivery = (installationId: number, secret?: string, appId = TEST_APP_ID) =>
  signedDelivery(
    "pull_request",
    pullRequestPayload("synchronize", { installationId, number: (n += 1) }),
    {
      ...(secret === undefined ? {} : { secret }),
      hookTarget: { type: "integration", id: String(appId) },
    },
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook rate limits (P7-3)", () => {
  it("genuine deliveries never spend the per-source budget", async () => {
    const { app, inbox } = setup({ ip: 2, installation: 100 });
    for (let i = 0; i < 10; i += 1) {
      const d = delivery(1);
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: d.headers,
        payload: d.body,
        remoteAddress: "198.51.100.1",
      });
      expect(res.statusCode).toBe(202);
    }
    expect(inbox.record).toHaveBeenCalledTimes(10);
  });

  it("bad signatures spend it; once spent, 429 before the body is read, per address", async () => {
    const { app, inbox } = setup({ ip: 2, installation: 100 });
    const parse = vi.spyOn(rawBodyParser, "parse");
    const from = (remoteAddress: string, secret?: string) => {
      const d = delivery(1, secret);
      return app.inject({
        method: "POST",
        url: URL,
        headers: d.headers,
        payload: d.body,
        remoteAddress,
      });
    };
    expect((await from("198.51.100.1", ATTACKER_SECRET)).statusCode).toBe(401);
    expect((await from("198.51.100.1", ATTACKER_SECRET)).statusCode).toBe(401);
    parse.mockClear();
    const limited = await from("198.51.100.1");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(parse).not.toHaveBeenCalled();
    expect(inbox.record).not.toHaveBeenCalled();
    // Another address is not affected.
    expect((await from("198.51.100.2")).statusCode).toBe(202);
  });

  it("another app's forged deliveries from GitHub's shared address do not block ours", async () => {
    const { app, recorded } = setup({ ip: 2, installation: 100 });
    const hookAddress = "140.82.115.10";
    // An attacker points their own GitHub App at Rocky with a wrong secret: GitHub delivers it
    // from the same pool of addresses, labelled with the attacker's app id.
    for (let i = 0; i < 10; i += 1) {
      const forged = delivery(7, ATTACKER_SECRET, 999);
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: forged.headers,
        payload: forged.body,
        remoteAddress: hookAddress,
      });
      expect(res.statusCode).toBe(i < 2 ? 401 : 429);
    }
    const genuine = delivery(7);
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: genuine.headers,
      payload: genuine.body,
      remoteAddress: hookAddress,
    });
    expect(res.statusCode).toBe(202);
    expect(recorded).toHaveLength(1);
  });

  it("junk that fails the precheck spends the budget too", async () => {
    const { app } = setup({ ip: 2, installation: 100 });
    for (let i = 0; i < 2; i += 1) {
      expect((await app.inject({ method: "POST", url: URL, payload: "x" })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: URL, payload: "x" })).statusCode).toBe(429);
  });

  it("an oversized body spends the budget", async () => {
    const { app } = setup({ ip: 1, installation: 100 });
    const big = pullRequestPayload("opened");
    (big["pull_request"] as Record<string, unknown>)["body"] = "x".repeat(WEBHOOK_BODY_LIMIT_BYTES);
    const tooBig = signedDelivery("pull_request", big);
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: tooBig.headers,
      payload: tooBig.body,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: "payload_too_large" });
    const d = delivery(1);
    const after = await app.inject({
      method: "POST",
      url: URL,
      headers: d.headers,
      payload: d.body,
    });
    expect(after.statusCode).toBe(429);
  });

  it("authenticated but unusable deliveries (bad payload) do not spend the per-source budget", async () => {
    const { app } = setup({ ip: 1, installation: 100 });
    for (let i = 0; i < 3; i += 1) {
      const d = signedDelivery("pull_request", { not: "a pull request" });
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: d.headers,
        payload: d.body,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("per installation after verification; other installations keep flowing", async () => {
    const { app, recorded } = setup({ ip: 1_000, installation: 2 });
    const post = (installationId: number) => {
      const d = delivery(installationId);
      return app.inject({ method: "POST", url: URL, headers: d.headers, payload: d.body });
    };
    expect((await post(7)).statusCode).toBe(202);
    expect((await post(7)).statusCode).toBe(202);
    const limited = await post(7);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect((await post(8)).statusCode).toBe(202);
    expect(recorded.map((d) => (d.event as { installationId: number }).installationId)).toEqual([
      7, 7, 8,
    ]);
  });

  it("replayed signed deliveries (inbox duplicates) do not spend the installation's budget", async () => {
    const { app, recorded } = setup({ ip: 1_000, installation: 2 });
    const replayed = delivery(7);
    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: replayed.headers,
        payload: replayed.body,
      });
      expect(res.statusCode).toBe(i === 0 ? 202 : 200);
    }
    const post = () => {
      const d = delivery(7);
      return app.inject({ method: "POST", url: URL, headers: d.headers, payload: d.body });
    };
    // One queued so far: one more fits, then the budget is spent.
    expect((await post()).statusCode).toBe(202);
    expect((await post()).statusCode).toBe(429);
    expect(recorded).toHaveLength(2);
  });

  it("forged deliveries naming an installation do not spend its budget", async () => {
    const { app, recorded } = setup({ ip: 1_000, installation: 2 });
    for (let i = 0; i < 10; i += 1) {
      const forged = delivery(7, ATTACKER_SECRET);
      const res = await app.inject({
        method: "POST",
        url: URL,
        headers: forged.headers,
        payload: forged.body,
      });
      expect(res.statusCode).toBe(401);
    }
    const genuine = delivery(7);
    const res = await app.inject({
      method: "POST",
      url: URL,
      headers: genuine.headers,
      payload: genuine.body,
    });
    expect(res.statusCode).toBe(202);
    expect(recorded).toHaveLength(1);
  });

  it("logs scope, hashed key and counts only (no address, no installation id in clear)", async () => {
    const { app, lines } = setup({ ip: 1, installation: 1 });
    // Two forged (spend and hit the address budget), then genuine ones from another address
    // (spend and hit the installation budget).
    for (let i = 0; i < 2; i += 1) {
      const d = delivery(987654, ATTACKER_SECRET);
      await app.inject({
        method: "POST",
        url: URL,
        headers: d.headers,
        payload: d.body,
        remoteAddress: "203.0.113.200",
      });
    }
    for (let i = 0; i < 3; i += 1) {
      const d = delivery(987654);
      await app.inject({
        method: "POST",
        url: URL,
        headers: d.headers,
        payload: d.body,
        remoteAddress: "203.0.113.201",
      });
    }
    const text = lines.join("\n");
    expect(text).toContain('"scope":"webhook.ip"');
    expect(text).toContain('"scope":"webhook.installation"');
    expect(text).not.toContain("203.0.113.20");
    expect(text).not.toContain("987654");
  });
});
