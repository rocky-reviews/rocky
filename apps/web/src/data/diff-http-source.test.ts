import { pr847Diff } from "@rocky-reviews/evals/pr-847/diff";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { describe, expect, it } from "vitest";
import { parseDiffData } from "./diff-data.js";
import { createHttpDiffSource, diffDataPath, DiffLoadError } from "./diff-http-source.js";

const REF = { owner: "acme", repo: "rocky-app", number: 847 };
const HEAD = pr847.provenance.head.sha;

/** A fetch that records each call and answers `status` with `body`. */
const answering = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

describe("server-backed diff source (H4-3)", () => {
  it("asks the server for the PR's diff by repository and number, same origin, no body", async () => {
    const { fetch, calls } = answering(200, {
      headSha: HEAD,
      diff: pr847Diff(),
      truncation: null,
      extra: "ignored",
    });
    const raw = await createHttpDiffSource({ fetch }).load(REF);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/repos/acme/rocky-app/pulls/847/diff");
    expect(calls[0]!.init).toMatchObject({ credentials: "same-origin" });
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(raw).not.toHaveProperty("extra");
    const data = parseDiffData(raw);
    expect(data.headSha).toBe(HEAD);
    expect(data.files.size).toBe(9);
    expect(data.truncated).toBe(false);
  });

  it("passes the truncation flag through for the parser to check", async () => {
    const { fetch } = answering(200, { headSha: HEAD, diff: "", truncation: "max_bytes" });
    const raw = await createHttpDiffSource({ fetch }).load(REF);
    expect(raw.truncation).toBe("max_bytes");
    expect(parseDiffData(raw).truncated).toBe(true);
  });

  it("encodes the names it puts in the path", () => {
    expect(diffDataPath({ owner: "a", repo: "b?c", number: 1 })).toBe(
      "/api/repos/a/b%3Fc/pulls/1/diff",
    );
  });

  it("turns each refusal into a fixed reason, without reading the body into the error", async () => {
    const cases: [number, string][] = [
      [401, "signed_out"],
      [404, "not_found"],
      [400, "not_found"],
      [409, "head_moved"],
      [413, "too_large"],
      [429, "rate_limited"],
      [502, "forge_failed"],
      [503, "unavailable"],
      [403, "failed"],
      [500, "failed"],
    ];
    for (const [status, reason] of cases) {
      const { fetch } = answering(status, { error: "Zebra-quartz secret" });
      const error = await createHttpDiffSource({ fetch })
        .load(REF)
        .catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(DiffLoadError);
      expect((error as DiffLoadError).reason, String(status)).toBe(reason);
      expect((error as Error).message).not.toContain("Zebra");
    }
  });

  it("an answer that is not a JSON object fails the load", async () => {
    for (const body of ["not json", "[]", "null"]) {
      const { fetch } = answering(200, body);
      await expect(createHttpDiffSource({ fetch }).load(REF)).rejects.toMatchObject({
        reason: "failed",
      });
    }
  });

  it("passes the abort signal to fetch", async () => {
    const { fetch, calls } = answering(200, { headSha: HEAD, diff: "", truncation: null });
    const abort = new AbortController();
    await createHttpDiffSource({ fetch }).load(REF, { signal: abort.signal });
    expect(calls[0]!.init?.signal).toBe(abort.signal);
  });
});
