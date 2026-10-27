import { createHash } from "node:crypto";
import type { LlmUsageTokens } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_TARGETS } from "./env.js";
import {
  costMicroUsd,
  modelPrice,
  PRICE_TABLES,
  priceTableAt,
  usd,
  type ModelPrice,
  type PriceTable,
} from "./prices.js";
import { BEDROCK_MODELS, CLAUDE_MODELS } from "./providers.js";

/**
 * P4-5 (ADR 0015): the cost table. Integer micro-USD, versioned, frozen once published, and
 * covering every catalogued Claude model on the platforms whose prices are verified.
 */

const tokens = (overrides: Partial<LlmUsageTokens> = {}): LlmUsageTokens => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  ...overrides,
});

const MTOK = 1_000_000;

const canonical = (table: PriceTable): string =>
  JSON.stringify(table, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );

/**
 * Digest of every published version. A published version is immutable: changing a price means
 * appending a new version, never editing this one (the digest then still matches).
 */
const PUBLISHED_DIGESTS: Readonly<Record<string, string>> = {
  "2026-10-27": "6649e8a8468cfc563d2597cbf4412c4cf69ecd1993b61893e15f192d617ee794",
};

const latest = PRICE_TABLES[PRICE_TABLES.length - 1]!;

const priceOf = (provider: string, model: string): ModelPrice => {
  const price = modelPrice(latest, provider, model);
  if (price === undefined) throw new Error(`no price for ${provider}/${model}`);
  return price;
};

describe("usd", () => {
  it("parses exact decimals into micro-USD per million tokens, without floats", () => {
    expect(usd("4")).toBe(4_000_000n);
    expect(usd("0.125")).toBe(125_000n);
    expect(usd("0.01")).toBe(10_000n);
    expect(usd("12.50")).toBe(12_500_000n);
    expect(usd("0.000001")).toBe(1n);
  });

  it("refuses anything that is not a plain non-negative decimal", () => {
    for (const bad of ["", "-1", "1e3", "0.0000001", "1.", ".5", "1,5", " 1", "NaN"]) {
      expect(() => usd(bad), bad).toThrow(RangeError);
    }
  });
});

describe("the price table", () => {
  it("is versioned: ordered versions and effective dates, in the shape usage rows store", () => {
    expect(PRICE_TABLES.length).toBeGreaterThan(0);
    const versions = PRICE_TABLES.map((t) => t.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 1; i < PRICE_TABLES.length; i++) {
      expect(versions[i]! > versions[i - 1]!).toBe(true);
      expect(Date.parse(PRICE_TABLES[i]!.effectiveFrom)).toBeGreaterThan(
        Date.parse(PRICE_TABLES[i - 1]!.effectiveFrom),
      );
    }
    // Mirrors llm_usage_price_version_shape (migration 0011).
    for (const v of versions) expect(v).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d{1,3})?$/);
  });

  it("pins every published version by digest (immutable once published)", () => {
    for (const table of PRICE_TABLES) {
      const digest = createHash("sha256").update(canonical(table)).digest("hex");
      expect(PUBLISHED_DIGESTS[table.version], `pin ${table.version}`).toBe(digest);
    }
  });

  it("is frozen at runtime, rates included", () => {
    const anthropic = latest.providers.anthropic;
    expect(Object.isFrozen(PRICE_TABLES)).toBe(true);
    expect(Object.isFrozen(latest)).toBe(true);
    expect(anthropic.status).toBe("verified");
    if (anthropic.status !== "verified") return;
    const opus = anthropic.models["claude-opus-5-5"]!;
    expect(Object.isFrozen(opus.rates)).toBe(true);
    expect(() => {
      (opus.rates as { input: bigint }).input = 0n;
    }).toThrow(TypeError);
    expect(opus.rates.input).toBe(usd("4"));
  });

  it("marks every verified platform with its source and the date it was read", () => {
    for (const [provider, prices] of Object.entries(latest.providers)) {
      if (prices.status === "verified") {
        expect(prices.source, provider).toMatch(/^https:\/\//);
        expect(prices.retrieved, provider).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } else {
        expect(prices.note.length, provider).toBeGreaterThan(0);
      }
    }
  });

  it("prices every catalogued Claude model on the Claude API and on Foundry", () => {
    for (const model of CLAUDE_MODELS.keys()) {
      expect(modelPrice(latest, "anthropic", model), model).toBeDefined();
      expect(modelPrice(latest, "foundry", model), model).toBeDefined();
    }
  });

  it("covers the default role models on every platform: priced, or an explicit placeholder", () => {
    const defaults = new Set(Object.values(DEFAULT_ROLE_TARGETS).map((target) => target.model));
    expect([...defaults].sort()).toEqual(
      ["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"].sort(),
    );
    for (const model of defaults) {
      expect(modelPrice(latest, "anthropic", model)).toBeDefined();
      expect(modelPrice(latest, "foundry", model)).toBeDefined();
      expect(BEDROCK_MODELS.has(model)).toBe(true);
      // Partner-priced platforms: no number until a human verifies one (needs-human).
      expect(modelPrice(latest, "bedrock", model)).toBeUndefined();
      expect(modelPrice(latest, "vertex", model)).toBeUndefined();
    }
    expect(latest.providers.bedrock.status).toBe("unverified");
    expect(latest.providers.vertex.status).toBe("unverified");
    expect(latest.providers["openai-compatible"].status).toBe("unverified");
  });

  it("has no price for an unknown model, provider or prototype key", () => {
    for (const model of ["claude-opus-9", "toString", "__proto__", "constructor", ""]) {
      expect(modelPrice(latest, "anthropic", model), model).toBeUndefined();
    }
    expect(modelPrice(latest, "teapot", "claude-opus-5-5")).toBeUndefined();
  });

  it("selects the version in effect at a date, and none before the first", () => {
    expect(priceTableAt(new Date("2026-10-27T00:00:00Z"))?.version).toBe("2026-10-27");
    expect(priceTableAt(new Date("2030-01-01T00:00:00Z"))?.version).toBe(latest.version);
    expect(priceTableAt(new Date("2026-10-26T23:59:59Z"))).toBeUndefined();
    const next: PriceTable = {
      ...latest,
      version: "2026-12-01",
      effectiveFrom: "2026-12-01T00:00:00Z",
    };
    const tables = [...PRICE_TABLES, next];
    expect(priceTableAt(new Date("2026-11-30T23:59:59Z"), tables)?.version).toBe("2026-10-27");
    expect(priceTableAt(new Date("2026-12-01T00:00:00Z"), tables)?.version).toBe("2026-12-01");
  });
});

describe("costMicroUsd", () => {
  it("prices each kind of token at its own rate (cache reads, 5-minute and 1-hour writes)", () => {
    const opus = priceOf("anthropic", "claude-opus-5-5");
    expect(costMicroUsd(opus, tokens({ inputTokens: MTOK }))).toBe(4_000_000);
    expect(costMicroUsd(opus, tokens({ outputTokens: MTOK }))).toBe(20_000_000);
    expect(costMicroUsd(opus, tokens({ cacheReadTokens: MTOK }))).toBe(200_000);
    expect(costMicroUsd(opus, tokens({ cacheWrite5mTokens: MTOK }))).toBe(5_000_000);
    expect(costMicroUsd(opus, tokens({ cacheWrite1hTokens: MTOK }))).toBe(8_000_000);
    expect(
      costMicroUsd(
        opus,
        tokens({
          inputTokens: 1200,
          outputTokens: 800,
          cacheReadTokens: 3000,
          cacheWrite5mTokens: 2048,
          cacheWrite1hTokens: 512,
        }),
      ),
      // 1200×4 + 800×20 + 3000×0.2 + 2048×5 + 512×8 = 4800 + 16000 + 600 + 10240 + 4096
    ).toBe(35_736);
  });

  it("uses the published rates of the default models", () => {
    const sonnet = priceOf("anthropic", "claude-sonnet-5-5");
    expect(sonnet.rates).toEqual({
      input: usd("2"),
      output: usd("10"),
      cacheRead: usd("0.10"),
      cacheWrite5m: usd("2.50"),
      cacheWrite1h: usd("4"),
    });
    const haiku = priceOf("anthropic", "claude-haiku-5-5");
    expect(haiku.rates).toEqual({
      input: usd("0.10"),
      output: usd("0.50"),
      cacheRead: usd("0.01"),
      cacheWrite5m: usd("0.125"),
      cacheWrite1h: usd("0.20"),
    });
  });

  it("puts a Haiku 5.5 prompt over 100 000 tokens, cached parts included, on the long-context card", () => {
    const haiku = priceOf("anthropic", "claude-haiku-5-5");
    // Exactly 100 000 prompt tokens: standard rates.
    expect(costMicroUsd(haiku, tokens({ inputTokens: 100_000, outputTokens: 1000 }))).toBe(
      10_000 + 500,
    );
    // One more token, carried by a cache read: the whole request pays the higher card.
    expect(
      costMicroUsd(haiku, tokens({ inputTokens: 100_000, cacheReadTokens: 1, outputTokens: 1000 })),
    ).toBe(50_000 + 0 + 2_500);
    // Cache writes count toward the prompt length too.
    expect(costMicroUsd(haiku, tokens({ inputTokens: 60_000, cacheWrite5mTokens: 40_001 }))).toBe(
      30_000 + 25_001,
    );
    // Other models have one card across the whole context window.
    const opus = priceOf("anthropic", "claude-opus-5-5");
    expect(costMicroUsd(opus, tokens({ inputTokens: 900_000 }))).toBe(3_600_000);
  });

  it("sums exactly and rounds half up once per row", () => {
    const haiku = priceOf("anthropic", "claude-haiku-5-5");
    // 4 × 0.1 µUSD = 0.4 → 0; 5 × 0.1 = 0.5 → 1; 15 × 0.1 = 1.5 → 2.
    expect(costMicroUsd(haiku, tokens({ inputTokens: 4 }))).toBe(0);
    expect(costMicroUsd(haiku, tokens({ inputTokens: 5 }))).toBe(1);
    expect(costMicroUsd(haiku, tokens({ inputTokens: 15 }))).toBe(2);
    // Parts are summed before rounding: 3 × 0.1 + 1 × 0.2 = 0.5 → 1, not 0 + 0.
    expect(costMicroUsd(haiku, tokens({ inputTokens: 3, cacheWrite1hTokens: 1 }))).toBe(1);
    // The largest count a row can hold stays exact (int4 tokens at the highest output rate).
    const fable = priceOf("anthropic", "claude-fable-5-1");
    expect(costMicroUsd(fable, tokens({ outputTokens: 2_147_483_647 }))).toBe(107_374_182_350);
  });
});
