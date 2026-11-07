import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  rockyInstructions,
  type LlmProvider,
  type ProviderCompletionCall,
} from "@rocky-reviews/core";
import { scrubSecrets } from "@rocky-reviews/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderSettings } from "../config.js";
import type { ProviderKind } from "../providers.js";
import { envSecrets } from "../registry.js";
import { providerAdapters } from "./index.js";
import {
  fakeFetch,
  fixture,
  sse,
  TEST_KEY,
  verdictSchema,
  type FakeResponse,
  type Verdict,
} from "./test-support.js";

/**
 * P4-2 criterion "no key ever logged" (ADR 0013, T1 and T7), for every adapter: a key sits in every
 * key variable; provider error bodies echo the key and the PR text back. Nothing the adapters
 * return, throw or log may contain either, and neither may the adapter objects or the fixtures.
 */

const SECRET_ENV = {
  ROCKY_TEST_ANTHROPIC_KEY: TEST_KEY,
  ROCKY_TEST_FOUNDRY_KEY: TEST_KEY,
  ROCKY_TEST_VLLM_KEY: TEST_KEY,
  ROCKY_TEST_OPENAI_KEY: TEST_KEY,
  ROCKY_TEST_VOYAGE_KEY: TEST_KEY,
};
const PR_SECRET_TEXT = "+ const internalToken = loadFromVault('payments-prod')";

/** Providers with completions; the embedding-only ones (P9-1) have their own block below. */
type CompletionKind = Exclude<ProviderKind, "openai" | "voyage">;
type EmbeddingOnlyKind = Extract<ProviderKind, "openai" | "voyage">;

const SETTINGS: Readonly<Record<CompletionKind, ProviderSettings>> = {
  anthropic: { kind: "anthropic", apiKeyEnv: "ROCKY_TEST_ANTHROPIC_KEY" },
  bedrock: { kind: "bedrock", region: "eu-west-1" },
  vertex: { kind: "vertex", projectId: "acme-ai", region: "global" },
  foundry: { kind: "foundry", resource: "acme-foundry", apiKeyEnv: "ROCKY_TEST_FOUNDRY_KEY" },
  "openai-compatible": {
    kind: "openai-compatible",
    baseUrl: "https://vllm.acme.example/v1",
    apiKeyEnv: "ROCKY_TEST_VLLM_KEY",
  },
};
const EMBEDDING_SETTINGS: Readonly<Record<EmbeddingOnlyKind, ProviderSettings>> = {
  openai: { kind: "openai", apiKeyEnv: "ROCKY_TEST_OPENAI_KEY" },
  voyage: { kind: "voyage", apiKeyEnv: "ROCKY_TEST_VOYAGE_KEY" },
};
const EMBEDDING_MODELS: Readonly<Record<EmbeddingOnlyKind, string>> = {
  openai: "text-embedding-3-small",
  voyage: "voyage-code-3",
};

const MODELS: Readonly<Record<CompletionKind, string>> = {
  anthropic: "claude-opus-5-5",
  bedrock: "claude-opus-5-5",
  vertex: "claude-opus-5-5",
  foundry: "claude-opus-5-5",
  "openai-compatible": "qwen2.5-coder:32b",
};

const echoingError = (status: number): FakeResponse => ({
  status,
  headers: { "content-type": "application/json", "request-id": `req_${TEST_KEY}` },
  body: JSON.stringify({
    type: "error",
    error: {
      type: "authentication_error",
      message: `invalid x-api-key ${TEST_KEY}; prompt was ${PR_SECRET_TEXT}`,
    },
  }),
});

const build = (kind: ProviderKind, responses: FakeResponse[]): LlmProvider => {
  const fake = fakeFetch(...responses);
  const adapters = providerAdapters({
    fetch: fake.fetch,
    maxRetries: 0,
    bedrockCredentials: () =>
      Promise.resolve(() =>
        Promise.resolve({ accessKeyId: "test-access-key-id", secretAccessKey: TEST_KEY }),
      ),
    vertexAuth: () =>
      Promise.resolve({
        projectId: "acme-ai",
        getRequestHeaders: () =>
          Promise.resolve(new Headers({ authorization: `Bearer ${TEST_KEY}` })),
      }),
  });
  const factory = adapters[kind] as (
    settings: ProviderSettings,
    secrets: ReturnType<typeof envSecrets>,
  ) => LlmProvider;
  const settings =
    kind in SETTINGS
      ? SETTINGS[kind as CompletionKind]
      : EMBEDDING_SETTINGS[kind as EmbeddingOnlyKind];
  return factory(settings, envSecrets(SECRET_ENV));
};

const call = (kind: CompletionKind): ProviderCompletionCall<Verdict> => ({
  role: "review",
  model: MODELS[kind],
  platformModel: undefined,
  effort: "high",
  instructions: rockyInstructions`Review the diff.`,
  untrusted: [{ label: "diff", text: PR_SECRET_TEXT }],
  output: verdictSchema,
  maxOutputTokens: 4000,
});

const assertClean = (text: string, label: string) => {
  expect(text, label).not.toContain(TEST_KEY);
  expect(text, label).not.toContain("Pq7wPq7w");
  expect(text, label).not.toContain("loadFromVault");
};

const describeError = (error: unknown): string =>
  [
    String(error),
    (error as Error).stack ?? "",
    JSON.stringify(error),
    inspect(error, { depth: 10, showHidden: true }),
    String((error as Error).cause ?? ""),
  ].join("\n");

const consoleCalls: unknown[][] = [];

beforeEach(() => {
  consoleCalls.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
  // A debugging operator turns SDK logging on; the adapters keep it off regardless.
  vi.stubEnv("ANTHROPIC_LOG", "debug");
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const okResponse = (kind: CompletionKind): FakeResponse =>
  kind === "openai-compatible"
    ? {
        body: fixture("openai-compatible/chat-stop.json"),
        headers: { "content-type": "application/json" },
      }
    : sse("end-turn.sse");

describe.each(Object.keys(EMBEDDING_SETTINGS) as EmbeddingOnlyKind[])(
  "key hygiene: %s embeddings",
  (kind) => {
    it("keeps the key and the embedded code out of results, errors, logs and the adapter", async () => {
      const provider = build(kind, [
        {
          body: fixture(`${kind}/embeddings.json`),
          headers: { "content-type": "application/json" },
        },
        echoingError(401),
        echoingError(500),
        echoingError(429),
      ]);
      assertClean(inspect(provider, { depth: 10, showHidden: true }), "adapter inspect");
      const embedCall = {
        inputs: [PR_SECRET_TEXT, PR_SECRET_TEXT],
        model: EMBEDDING_MODELS[kind],
        dimensions: 4,
      };
      const result = await provider.embed!(embedCall);
      assertClean(JSON.stringify(result), "result");
      for (const expected of ["auth", "server_error", "rate_limited"]) {
        try {
          await provider.embed!(embedCall);
          expect.unreachable();
        } catch (error) {
          expect((error as { kind: string }).kind).toBe(expected);
          assertClean(describeError(error), `error ${expected}`);
        }
      }
      expect(consoleCalls).toEqual([]);
      assertClean(
        inspect(provider, { depth: 10, showHidden: true }),
        "adapter inspect after calls",
      );
    });
  },
);

describe.each(Object.keys(SETTINGS) as CompletionKind[])("key hygiene: %s", (kind) => {
  it("keeps the key and PR content out of results, errors, logs and the adapter object", async () => {
    const provider = build(kind, [
      okResponse(kind),
      echoingError(401),
      echoingError(500),
      echoingError(429),
    ]);
    assertClean(inspect(provider, { depth: 10, showHidden: true }), "adapter inspect");
    assertClean(JSON.stringify(provider) ?? "", "adapter JSON");

    const result = await provider.completeStructured!(call(kind));
    expect(result.status).toBe("ok");
    assertClean(JSON.stringify(result), "result");

    for (const expected of ["auth", "server_error", "rate_limited"]) {
      try {
        await provider.completeStructured!(call(kind));
        expect.unreachable();
      } catch (error) {
        expect((error as { kind: string }).kind).toBe(expected);
        assertClean(describeError(error), `error ${expected}`);
      }
    }
    // The adapters log nothing at all, with SDK debug logging requested by the environment.
    expect(consoleCalls).toEqual([]);
    assertClean(inspect(provider, { depth: 10, showHidden: true }), "adapter inspect after calls");
  });
});

describe("fixture hygiene", () => {
  const root = fileURLToPath(new URL("../../fixtures/", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("contains no credential-shaped value, account id or test key", () => {
    const all = files(root);
    expect(all.length).toBeGreaterThan(15);
    for (const path of all) {
      const text = readFileSync(path, "utf8");
      expect(scrubSecrets(text), path).toBe(text);
      assertClean(text, path);
      // No AWS account ids or ARNs, and no real-looking project ids.
      expect(text, path).not.toMatch(/\b\d{12}\b|arn:aws:/);
    }
  });
});
