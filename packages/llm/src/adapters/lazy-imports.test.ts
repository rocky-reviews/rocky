import { isLlmCallError, rockyInstructions, type LlmProvider } from "@rocky-reviews/core";
import { describe, expect, it, vi } from "vitest";
import type { ProviderSettings } from "../config.js";
import { envSecrets } from "../registry.js";
import { providerAdapters } from "./index.js";
import { fakeFetch, sse, TEST_KEY, verdictSchema } from "./test-support.js";

/**
 * Review round 1, N6 and S3: the platform SDKs load only when a call needs them, and the Vertex
 * default credentials (google-auth-library) are rebuilt after a failed lookup. The modules are
 * wrapped, not replaced, so each records when it is first imported.
 */

const loads = vi.hoisted(() => [] as string[]);
const google = vi.hoisted(() => ({ attempts: 0, scopes: [] as unknown[] }));

vi.mock("@anthropic-ai/bedrock-sdk", async (original) => {
  loads.push("bedrock");
  return original();
});
vi.mock("@anthropic-ai/vertex-sdk", async (original) => {
  loads.push("vertex");
  return original();
});
vi.mock("@anthropic-ai/foundry-sdk", async (original) => {
  loads.push("foundry");
  return original();
});
vi.mock("google-auth-library", () => {
  loads.push("google-auth-library");
  class GoogleAuth {
    constructor(options: { scopes?: unknown }) {
      google.scopes.push(options.scopes);
    }
    getClient() {
      google.attempts += 1;
      return google.attempts === 1
        ? Promise.reject(new Error("Could not load the default credentials"))
        : Promise.resolve({
            projectId: "acme-ai",
            getRequestHeaders: () =>
              Promise.resolve(new Headers({ authorization: "Bearer vertex-test-token" })),
          });
    }
  }
  return { GoogleAuth };
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

const build = (settings: ProviderSettings, fetch: typeof globalThis.fetch): LlmProvider => {
  const factory = providerAdapters({
    fetch,
    maxRetries: 0,
    bedrockCredentials: () =>
      Promise.resolve(() =>
        Promise.resolve({ accessKeyId: "test-access-key-id", secretAccessKey: "test-secret" }),
      ),
  })[settings.kind] as (settings: ProviderSettings, secrets: unknown) => LlmProvider;
  return factory(settings, envSecrets({ ROCKY_TEST_KEY: TEST_KEY }));
};

describe("platform SDKs load on first use (N6)", () => {
  it("loads nothing for the Anthropic API, and only the platform a call uses", async () => {
    const fake = fakeFetch(sse("end-turn.sse"));
    const anthropic = build({ kind: "anthropic", apiKeyEnv: "ROCKY_TEST_KEY" }, fake.fetch);
    const bedrock = build({ kind: "bedrock", region: "us-east-1" }, fake.fetch);
    build({ kind: "foundry", resource: "acme", apiKeyEnv: "ROCKY_TEST_KEY" }, fake.fetch);
    build({ kind: "vertex", projectId: "acme-ai", region: "global" }, fake.fetch);
    expect(loads).toEqual([]);

    expect((await anthropic.completeStructured!(request)).status).toBe("ok");
    expect(loads).toEqual([]);

    expect((await bedrock.completeStructured!(request)).status).toBe("ok");
    expect(loads).toEqual(["bedrock"]);
  });
});

describe("Vertex default credentials (S3)", () => {
  it("drops a failed lookup and builds the credentials again on the next call", async () => {
    const fake = fakeFetch(sse("end-turn.sse"));
    const vertex = build({ kind: "vertex", projectId: "acme-ai", region: "global" }, fake.fetch);

    const error = await vertex.completeStructured!(request).catch((caught: unknown) => caught);
    expect(isLlmCallError(error) && error.kind).toBe("network");
    expect(String(error)).not.toContain("default credentials");
    expect(fake.requests).toHaveLength(0);

    expect((await vertex.completeStructured!(request)).status).toBe("ok");
    expect((await vertex.completeStructured!(request)).status).toBe("ok");
    expect(google.attempts).toBe(2);
    expect(google.scopes).toEqual([
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/cloud-platform",
    ]);
    expect(fake.requests[0]!.headers["authorization"]).toBe("Bearer vertex-test-token");
    expect(loads).toContain("google-auth-library");
  });
});
