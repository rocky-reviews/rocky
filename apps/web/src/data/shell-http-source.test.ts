import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { describe, expect, it } from "vitest";
import { PR_847_PULL } from "./fixture-source.js";
import { parseShellData } from "./shell-data.js";
import { createHttpShellSource, ShellLoadError, shellDataPath } from "./shell-http-source.js";

const REF = { owner: "acme", repo: "rocky-app", number: 847 };
const ID = "6f1c2a9e-1d4b-4c3e-9a7f-0b2d4e6f8a1c";

/** A fetch that records each call and answers `status` with `body`. */
const answering = (status: number, body: unknown) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
};

describe("server-backed shell source (H4-2)", () => {
  it("asks the server for the PR by repository and number, same origin, no body", async () => {
    const answer = {
      pullRequestId: ID,
      pull: { ...PR_847_PULL, headRef: null, baseRef: null, approvers: null, commentCount: null },
      myReview: "commented",
      analysis: pr847,
      analysisId: ID,
      analysisRun: { status: "done" },
      extra: "ignored",
    };
    const { fetch, calls } = answering(200, answer);
    const raw = await createHttpShellSource({ fetch }).load(REF);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/repos/acme/rocky-app/pulls/847");
    expect(calls[0]!.init).toMatchObject({ credentials: "same-origin" });
    expect(calls[0]!.init?.method).toBeUndefined();
    expect(raw).not.toHaveProperty("extra");
    const data = parseShellData(raw);
    expect(data).toMatchObject({ myReview: "commented", analysisId: ID, pullRequestId: ID });
    expect(data.pull.headRef).toBeNull();
  });

  it("encodes the names it puts in the path", () => {
    expect(shellDataPath({ owner: "a", repo: "b?c", number: 1 })).toBe(
      "/api/repos/a/b%3Fc/pulls/1",
    );
  });

  it("turns each refusal into a fixed reason, without reading the body into the error", async () => {
    const cases: [number, string][] = [
      [401, "signed_out"],
      [404, "not_found"],
      [400, "not_found"],
      [503, "unavailable"],
      [409, "failed"],
      [403, "failed"],
      [500, "failed"],
    ];
    for (const [status, reason] of cases) {
      const { fetch } = answering(status, { error: "Zebra-quartz secret" });
      const error = await createHttpShellSource({ fetch })
        .load(REF)
        .catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(ShellLoadError);
      expect((error as ShellLoadError).reason, String(status)).toBe(reason);
      expect((error as Error).message).not.toContain("Zebra");
    }
  });

  it("an answer that is not a JSON object fails the load", async () => {
    for (const body of ["not json", "[]", "null"]) {
      const { fetch } = answering(200, body);
      await expect(createHttpShellSource({ fetch }).load(REF)).rejects.toMatchObject({
        reason: "failed",
      });
    }
  });

  it("a missing document field is refused by the parser, not taken as 'no analysis'", async () => {
    const { fetch } = answering(200, { pull: PR_847_PULL, myReview: null });
    const raw = await createHttpShellSource({ fetch }).load(REF);
    expect(() => parseShellData(raw)).toThrow("invalid analysis document");
  });
});
