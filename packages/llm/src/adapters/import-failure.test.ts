import { isLlmCallError, rockyInstructions, type LlmProvider } from "@rocky-reviews/core";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSettings } from "../config.js";
import { envSecrets } from "../registry.js";
import { vertexAuthOnce } from "./claude-platforms.js";
import { providerAdapters } from "./index.js";
import { fakeFetch, sse, TEST_KEY, verdictSchema } from "./test-support.js";

/**
 * Review round 2, nits 1 and 3: a platform SDK (or google-auth-library) that fails to import is a
 * broken install, so the call fails with a fatal kind; and the Vertex auth cache drops only the
 * lookup that failed.
 */

vi.mock("@anthropic-ai/bedrock-sdk", () => {
  throw new Error("Cannot find module '@aws-sdk/credential-providers'");
});
vi.mock("@anthropic-ai/foundry-sdk", () => {
  throw new Error("Cannot find module");
});
vi.mock("google-auth-library", () => {
  throw new Error("Cannot find module 'gaxios'");
});

const request = {
  role: "review" as const,
  model: "claude-opus-5-5",
  platformModel: undefined,
  effort: undefined,
  instructions: rockyInstructions`Review the diff.`,
  untrusted: [{ label: "diff", text: "+ x" }],
  output: verdictSchema,
  maxOutputTokens: 1024,
};

const build = (settings: ProviderSettings) => {
  const fake = fakeFetch(sse("end-turn.sse"));
  const factory = providerAdapters({ fetch: fake.fetch, maxRetries: 0 })[settings.kind] as (
    settings: ProviderSettings,
    secrets: unknown,
  ) => LlmProvider;
  return { provider: factory(settings, envSecrets({ ROCKY_TEST_KEY: TEST_KEY })), fake };
};

describe("a platform SDK that fails to import (review round 2, nit 3)", () => {
  it.each<ProviderSettings>([
    { kind: "bedrock", region: "us-east-1" },
    { kind: "foundry", resource: "acme", apiKeyEnv: "ROCKY_TEST_KEY" },
    { kind: "vertex", projectId: "acme-ai", region: "global" },
  ])("fails $kind fatally, every time, sending nothing", async (settings) => {
    const { provider, fake } = build(settings);
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await provider.completeStructured!(request).catch((caught: unknown) => caught);
      expect(isLlmCallError(error) && error.kind).toBe("invalid_request");
      expect(isLlmCallError(error) && error.retryable).toBe(false);
      expect(String(error)).not.toContain("Cannot find module");
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe("vertexAuthOnce (review round 2, nit 1)", () => {
  it("keeps a newer lookup when an older one fails late", async () => {
    let reject: (error: Error) => void = () => undefined;
    const first = new Promise<never>((_, no) => {
      reject = no;
    });
    const second = Promise.resolve({
      projectId: "acme-ai",
      getRequestHeaders: () => Promise.resolve(new Headers()),
    });
    const lookups = [first, second];
    let calls = 0;
    const auth = vertexAuthOnce(() => lookups[calls++]!);

    const early = auth();
    // Runs after `early` has dropped the failed lookup and before `late` reacts to it.
    let newer: Promise<unknown> | undefined;
    first.catch(() => {
      newer = auth();
    });
    const late = auth();
    reject(new Error("metadata server unreachable"));

    await expect(early).rejects.toMatchObject({ kind: "network" });
    await expect(late).rejects.toMatchObject({ kind: "network" });
    await expect(newer).resolves.toMatchObject({ projectId: "acme-ai" });
    await expect(auth()).resolves.toMatchObject({ projectId: "acme-ai" });
    expect(calls).toBe(2);
  });
});
