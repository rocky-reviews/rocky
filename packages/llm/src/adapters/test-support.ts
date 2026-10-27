import { readFileSync } from "node:fs";
import type { LlmOutputSchema } from "@rocky-reviews/core";
import { z } from "zod";

/**
 * Test support for the provider contract tests (P4-2, ADR 0013): an injected `fetch` that records
 * each request and answers with a fixture from `packages/llm/fixtures/`. No test reaches a live
 * API. Test-only; not exported from the package.
 */

export interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
  readonly redirect: RequestInit["redirect"];
}

export interface FakeResponse {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Reject the fetch instead of answering (a connection failure). */
  readonly fail?: Error;
  /** Never answer until the request is aborted. */
  readonly hang?: boolean;
  /**
   * Answer headers, send `prefix`, then `chunk` every `everyMs` forever: a server that never
   * finishes (S1). The body errors when the request is aborted, like a real fetch.
   */
  readonly drip?: { readonly prefix: string; readonly chunk: string; readonly everyMs: number };
  /** Answer 200 headers, send `prefix` (maybe empty), then fail the body (a reset connection). */
  readonly reset?: { readonly prefix: string };
}

type Responder = FakeResponse | ((request: RecordedRequest) => FakeResponse);

export interface FakeFetch {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: RecordedRequest[];
}

const parseBody = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "string" || body === "") return {};
  return JSON.parse(body) as Record<string, unknown>;
};

/** Answers the n-th request with the n-th responder (the last one repeats). */
export const fakeFetch = (...responders: Responder[]): FakeFetch => {
  const requests: RecordedRequest[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const request: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: parseBody(init?.body),
      redirect: init?.redirect,
    };
    requests.push(request);
    const responder = responders[Math.min(requests.length - 1, responders.length - 1)];
    const response = typeof responder === "function" ? responder(request) : (responder ?? {});
    if (response.fail !== undefined) throw response.fail;
    if (response.hang === true) {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted === true) abort();
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if (response.reset !== undefined) {
      const prefix = new TextEncoder().encode(response.reset.prefix);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (prefix.byteLength > 0) controller.enqueue(prefix);
        },
        pull(controller) {
          controller.error(new TypeError("terminated: other side closed"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (response.drip !== undefined) {
      const { prefix, chunk, everyMs } = response.drip;
      const encoder = new TextEncoder();
      const signal = init?.signal;
      let timer: ReturnType<typeof setInterval> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(prefix));
          timer = setInterval(() => controller.enqueue(encoder.encode(chunk)), everyMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearInterval(timer);
              controller.error(signal.reason ?? new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(response.body ?? "", {
      status: response.status ?? 200,
      headers: response.headers ?? {},
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
};

export const fixture = (path: string): string =>
  readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), "utf8");

/** A Messages API event stream from `fixtures/claude/`. */
export const sse = (name: string, headers: Record<string, string> = {}): FakeResponse => ({
  body: fixture(`claude/${name}`),
  headers: { "content-type": "text/event-stream", ...headers },
});

/** A Messages stream that starts a text block and then sends `text` deltas forever. */
export const drippingStream = (text: string, everyMs: number): FakeResponse => {
  const [head = ""] = fixture("claude/end-turn.sse").split("event: content_block_start");
  const start =
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"","citations":null}}\n\n';
  const delta = `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text },
  })}\n\n`;
  return { drip: { prefix: head + start, chunk: delta, everyMs } };
};

/** A JSON answer from a fixture file. */
export const json = (
  path: string,
  status = 200,
  headers: Record<string, string> = {},
): FakeResponse => ({
  status,
  body: fixture(path),
  headers: { "content-type": "application/json", ...headers },
});

/** The output contract the fixtures answer: a review verdict (stands in for the analysis doc). */
const Verdict = z.strictObject({
  verdict: z.enum(["approve", "comment", "request_changes"]),
  summary: z.string().min(1).max(2000),
});
export type Verdict = z.infer<typeof Verdict>;

export const verdictSchema: LlmOutputSchema<Verdict> = {
  name: "review_verdict",
  jsonSchema: z.toJSONSchema(Verdict) as Record<string, unknown>,
  parse: (value) => {
    const parsed = Verdict.safeParse(value);
    return parsed.success
      ? { success: true, data: parsed.data }
      : {
          success: false,
          issues: parsed.error.issues.map(
            (issue) =>
              `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.code}`,
          ),
        };
  },
};

export const ANSWER: Verdict = {
  verdict: "comment",
  summary: "Adds a retry loop; one error path is unchecked.",
};

/** Built at runtime so no scanner sees a key-shaped literal in the repo. */
export const TEST_KEY = ["sk", "ant", "api03", "Pq7w".repeat(10)].join("-");
export const OTHER_KEY = ["sk", "ant", "api03", "Ambient".repeat(6)].join("-");

/**
 * Runs `body` and returns how many timers armed with `delayMs` are still pending afterwards:
 * a call must clear its deadline timer when it ends (review round 2, nit 6).
 */
export const pendingTimers = async (delayMs: number, body: () => Promise<unknown>) => {
  const armed = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((handler: () => void, delay?: number) => {
    const id = realSet(handler, delay);
    if (delay === delayMs) armed.add(id);
    return id;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
    armed.delete(id);
    realClear(id);
  }) as typeof globalThis.clearTimeout;
  try {
    await body().catch(() => undefined);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  return armed.size;
};
