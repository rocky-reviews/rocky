import { describe, expect, it } from "vitest";
import { createHttpAskSource } from "./ask-http-source.js";

/**
 * P9-3: the server's Ask source hands a 429's `retry-after` over as seconds, when it is a plain
 * number of them; the rest of what it sends is covered end to end in `e2e/ask.e2e.spec.ts`.
 */

const PULL = { owner: "acme", repo: "rocky-app", number: 847 };

/** A fetch that answers `status` with `body` and `headers`, recording each call. */
const answering = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

const source = (fetch: typeof globalThis.fetch) =>
  createHttpAskSource({ fetch, csrfToken: () => Promise.resolve("csrf-token") });

describe("the server's Ask source", () => {
  it("passes a 429's retry-after seconds through with the status and body", async () => {
    const { fetch, calls } = answering(
      429,
      { error: "rate_limited", limit: "org" },
      { "retry-after": "1800" },
    );
    const answer = await source(fetch).ask(PULL, { question: "q" });
    expect(answer).toEqual({
      status: 429,
      body: { error: "rate_limited", limit: "org" },
      retryAfterSeconds: 1800,
    });
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      headers: { "x-rocky-csrf": "csrf-token" },
    });
  });

  it("leaves the wait out without the header, or with one it cannot read", async () => {
    for (const headers of [
      {},
      { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
      { "retry-after": "0" },
      { "retry-after": "86401" },
      { "retry-after": "1.5" },
    ]) {
      const { fetch } = answering(429, { error: "rate_limited" }, headers);
      const answer = await source(fetch).ask(PULL, { question: "q" });
      expect(answer, JSON.stringify(headers)).toEqual({
        status: 429,
        body: { error: "rate_limited" },
      });
      expect(answer).not.toHaveProperty("retryAfterSeconds");
    }
  });

  it("reads the header on any status; the parser decides whether it means anything", async () => {
    const { fetch } = answering(200, { index: { status: "ready" } }, { "retry-after": "5" });
    expect(await source(fetch).index(PULL)).toEqual({
      status: 200,
      body: { index: { status: "ready" } },
      retryAfterSeconds: 5,
    });
  });
});
