/**
 * Property tests (P3-2 "fuzzed payloads don't crash"): the ingress never throws, never accepts
 * an unsigned request, and every event it does accept satisfies the invariants storage relies
 * on. Seeded, so CI is deterministic; change SEED locally to explore.
 */
import { isForgeEventType, type ForgeEvent, type WebhookReceipt } from "@rocky-reviews/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createGitHubWebhookIngress } from "./ingress.js";
import { signWebhookBody } from "./signature.js";
import { installationPayload, pullRequestPayload, TEST_WEBHOOK_SECRET } from "./testing.js";

const SEED = 20261026;
const RUNS = 400;
const ingress = createGitHubWebhookIngress({ secret: TEST_WEBHOOK_SECRET });

const OUTCOMES = new Set(["rejected", "ping", "ignored", "accepted"]);
const ID = (v: number) => Number.isSafeInteger(v) && v > 0;

const assertEventInvariants = (event: ForgeEvent): void => {
  expect(isForgeEventType(event.type)).toBe(true);
  expect(ID(event.installationId)).toBe(true);
  if ("account" in event) {
    expect(ID(event.account.id)).toBe(true);
    expect(event.account.login).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
    expect(["organization", "user"]).toContain(event.account.kind);
    expect(Object.keys(event).sort()).toEqual(["account", "installationId", "type"]);
  } else {
    expect(ID(event.repositoryId)).toBe(true);
    expect(Number.isInteger(event.number) && event.number > 0 && event.number < 2 ** 31).toBe(true);
    expect(event.headSha).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    expect(typeof event.merged).toBe("boolean");
    expect(Object.keys(event).sort()).toEqual([
      "headSha",
      "installationId",
      "merged",
      "number",
      "repositoryId",
      "type",
    ]);
  }
};

const check = (receipt: WebhookReceipt): void => {
  expect(OUTCOMES.has(receipt.outcome)).toBe(true);
  if (receipt.outcome === "accepted") assertEventInvariants(receipt.delivery.event);
};

const headerMap = fc.dictionary(
  fc.oneof(
    fc.constantFrom(
      "content-type",
      "x-github-event",
      "x-github-delivery",
      "x-hub-signature-256",
      "x-hub-signature",
    ),
    fc.string({ maxLength: 20 }),
  ),
  fc.oneof(fc.string({ maxLength: 200 }), fc.constant("sha256=" + "0".repeat(64))),
  { maxKeys: 8 },
);

const request = (headers: Record<string, string>, body: Uint8Array) => ({
  body,
  header: (name: string) => (Object.hasOwn(headers, name) ? headers[name] : undefined),
});

const signedHeaders = (event: string, body: Uint8Array, delivery: string) => ({
  "content-type": "application/json",
  "x-github-event": event,
  "x-github-delivery": delivery,
  "x-hub-signature-256": signWebhookBody(TEST_WEBHOOK_SECRET, body),
});

/** Replaces the value at a random path of a JSON object (structure-aware mutation). */
const mutate = (value: unknown, path: readonly number[], replacement: unknown): unknown => {
  if (path.length === 0 || value === null || typeof value !== "object") return replacement;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return replacement;
  const index = path[0]! % entries.length;
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? [...value]
    : { ...value };
  const [key, child] = entries[index]!;
  (copy as Record<string, unknown>)[key] = mutate(child, path.slice(1), replacement);
  return copy;
};

describe("ingress under fuzzing", () => {
  it("never throws and never accepts unsigned requests (random headers and bytes)", () => {
    fc.assert(
      fc.property(headerMap, fc.uint8Array({ maxLength: 2048 }), (headers, body) => {
        const receipt = ingress.receive(request(headers, body));
        check(receipt);
        expect(receipt).toEqual({ outcome: "rejected", reason: "unauthenticated" });
      }),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("never throws on signed random bytes under any event name", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("installation", "pull_request", "ping", "issues", "push"),
        fc.uint8Array({ maxLength: 4096 }),
        fc.uuid(),
        (event, body, delivery) => {
          const receipt = ingress.receive(request(signedHeaders(event, body, delivery), body));
          check(receipt);
          expect(receipt.outcome).not.toBe("accepted");
        },
      ),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("never throws on signed arbitrary JSON values", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("installation", "pull_request"),
        fc.jsonValue({ maxDepth: 6 }),
        fc.uuid(),
        (event, value, delivery) => {
          const body = Buffer.from(JSON.stringify(value) ?? "null");
          check(ingress.receive(request(signedHeaders(event, body, delivery), body)));
        },
      ),
      { seed: SEED, numRuns: RUNS },
    );
  });

  it("accepted events keep their invariants when valid payloads are mutated anywhere", () => {
    const valid = fc.oneof(
      fc
        .constantFrom("created", "deleted", "suspend")
        .map((a) => ["installation", installationPayload(a)] as const),
      fc
        .constantFrom("opened", "synchronize", "closed", "reopened", "labeled")
        .map((a) => ["pull_request", pullRequestPayload(a)] as const),
    );
    fc.assert(
      fc.property(
        valid,
        fc.array(fc.nat(), { maxLength: 5 }),
        fc.oneof(
          fc.jsonValue({ maxDepth: 3 }),
          fc.constantFrom(-1, 0, 1.5, 2 ** 53, "", "a".repeat(5000), null, [], {}),
        ),
        fc.uuid(),
        ([event, payload], path, replacement, delivery) => {
          const body = Buffer.from(JSON.stringify(mutate(payload, path, replacement)));
          check(ingress.receive(request(signedHeaders(event, body, delivery), body)));
        },
      ),
      { seed: SEED, numRuns: RUNS * 2 },
    );
  });
});
