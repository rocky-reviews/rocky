import type { WebhookDelivery, WebhookInbox } from "@rocky-reviews/core";
import { createGitHubWebhookIngress } from "@rocky-reviews/forge-github";
import {
  pullRequestPayload,
  signedDelivery,
  TEST_WEBHOOK_SECRET,
} from "@rocky-reviews/forge-github/testing";
import { createLogger } from "@rocky-reviews/log";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createRateLimits, DEFAULT_RATE_LIMITS } from "./security/rate-limit.js";
import { webhookRateLimit } from "./security/route-limits.js";
import { rawBodyParser } from "./webhooks.js";

/**
 * P7-3 (ADR 0025): webhook floods. A cheap per-address limit runs before the body is read; a
 * per-installation limit runs only after the signature holds, so forged deliveries cannot spend
 * an installation's budget.
 */

const URL = "/webhooks/github";

const setup = (rules: { ip: number; installation: number }) => {
  const lines: string[] = [];
  const log = createLogger("webhook-limit-test", {
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  const recorded: WebhookDelivery[] = [];
  const inbox: WebhookInbox = {
    record: vi.fn(async (d: WebhookDelivery) => {
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
      ingress: createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET }),
      inbox,
      rateLimit: webhookRateLimit(limits),
    },
  });
  return { app, recorded, inbox, lines };
};

let n = 0;
const delivery = (installationId: number, secret?: string) =>
  signedDelivery(
    "pull_request",
    pullRequestPayload("synchronize", { installationId, number: (n += 1) }),
    secret === undefined ? {} : { secret },
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("webhook rate limits (P7-3)", () => {
  it("per source address before the body is read: 429, nothing parsed, nothing recorded", async () => {
    const { app, inbox } = setup({ ip: 2, installation: 100 });
    const parse = vi.spyOn(rawBodyParser, "parse");
    const from = (remoteAddress: string) => {
      const d = delivery(1);
      return app.inject({
        method: "POST",
        url: URL,
        headers: d.headers,
        payload: d.body,
        remoteAddress,
      });
    };
    expect((await from("198.51.100.1")).statusCode).toBe(202);
    expect((await from("198.51.100.1")).statusCode).toBe(202);
    parse.mockClear();
    const limited = await from("198.51.100.1");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect(parse).not.toHaveBeenCalled();
    expect(inbox.record).toHaveBeenCalledTimes(2);
    // Another address is not affected.
    expect((await from("198.51.100.2")).statusCode).toBe(202);
  });

  it("the address limit also counts junk that fails the precheck", async () => {
    const { app } = setup({ ip: 2, installation: 100 });
    for (let i = 0; i < 2; i += 1) {
      expect((await app.inject({ method: "POST", url: URL, payload: "x" })).statusCode).toBe(401);
    }
    expect((await app.inject({ method: "POST", url: URL, payload: "x" })).statusCode).toBe(429);
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

  it("forged deliveries naming an installation do not spend its budget", async () => {
    const { app, recorded } = setup({ ip: 1_000, installation: 2 });
    for (let i = 0; i < 10; i += 1) {
      const forged = delivery(7, "attacker-secret-that-is-long-enough-000000");
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
    for (let i = 0; i < 3; i += 1) {
      const d = delivery(987654);
      await app.inject({
        method: "POST",
        url: URL,
        headers: d.headers,
        payload: d.body,
        remoteAddress: "203.0.113.200",
      });
    }
    const text = lines.join("\n");
    expect(text).toContain('"scope":"webhook.ip"');
    expect(text).not.toContain("203.0.113.200");
    expect(text).not.toMatch(/"keyHash":"987654"/);
  });
});
