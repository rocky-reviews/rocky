import type { LlmUsageTokens } from "@rocky-reviews/core";
import type { ProviderKind } from "./providers.js";

/**
 * The LLM cost table (P4-5, ADR 0016): providers' public list prices, versioned. Every usage row
 * records the version it was priced under, so a price change is a new version, never an edit:
 * a published version is frozen here and pinned by digest in `prices.test.ts`, which fails if
 * anyone changes it. These are list prices (public facts), not what anyone is charged.
 *
 * Money is integer micro-USD (µUSD) throughout; there are no floats. A rate is µUSD per million
 * tokens, written as an exact decimal string (`usd("0.125")` = 125 000 µUSD/MTok), so the cost of
 * a count is `tokens × rate / 1 000 000` µUSD, summed exactly as a bigint and rounded half up to a
 * whole µUSD once per usage row (at most 0.5 µUSD off per row).
 *
 * A provider and model without a verified entry has no price: its rows record tokens with a null
 * cost and `no_price`. Nothing is guessed, extrapolated or copied from another platform.
 */

/** µUSD per million tokens for each kind of token the providers bill. */
export interface TokenRates {
  readonly input: bigint;
  readonly output: bigint;
  readonly cacheRead: bigint;
  readonly cacheWrite5m: bigint;
  readonly cacheWrite1h: bigint;
}

export interface ModelPrice {
  readonly rates: TokenRates;
  /**
   * A higher rate card for long prompts (Claude Haiku 5.5). A prompt is "longer than
   * `aboveTokens`" when input + cache reads + cache writes exceed it; the whole request then pays
   * `rates`, cached parts included (pricing page, "Long context pricing").
   */
  readonly longContext?: { readonly aboveTokens: number; readonly rates: TokenRates };
}

export type ProviderPrices =
  | {
      readonly status: "verified";
      readonly source: string;
      /** The date the source was read (UTC). */
      readonly retrieved: string;
      readonly models: Readonly<Record<string, ModelPrice>>;
    }
  | {
      /** A clearly marked placeholder: no price is used until a human verifies one. */
      readonly status: "unverified";
      readonly note: string;
    };

export interface PriceTable {
  /** `YYYY-MM-DD`, optionally `.N` for a second version on the same day. */
  readonly version: string;
  /** The first instant (UTC) this version applies to. */
  readonly effectiveFrom: string;
  readonly providers: Readonly<Record<ProviderKind, ProviderPrices>>;
}

const DECIMAL = /^(\d{1,6})(?:\.(\d{1,6}))?$/;

/** An exact USD decimal per million tokens → µUSD per million tokens. */
export const usd = (amount: string): bigint => {
  const match = DECIMAL.exec(amount);
  if (match === null) throw new RangeError("usd: expected a plain decimal amount");
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  return whole * 1_000_000n + fraction;
};

const rates = (
  input: string,
  output: string,
  cacheRead: string,
  cacheWrite5m: string,
  cacheWrite1h: string,
): TokenRates => ({
  input: usd(input),
  output: usd(output),
  cacheRead: usd(cacheRead),
  cacheWrite5m: usd(cacheWrite5m),
  cacheWrite1h: usd(cacheWrite1h),
});

const flat = (...args: Parameters<typeof rates>): ModelPrice => ({ rates: rates(...args) });

/**
 * Claude API list prices, USD per million tokens: base input, output, cache hits and refreshes,
 * 5-minute cache writes, 1-hour cache writes.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing ("Model pricing", "Long
 * context pricing"), read 2026-10-27. Prices are global routing (Rocky sends no
 * `inference_geo`), standard speed, no batch discount: the only way Rocky calls these models.
 */
const CLAUDE_API_2026_10_27: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": flat("10", "50", "0.25", "12.50", "20"),
  "claude-fable-5": flat("10", "50", "1", "12.50", "20"),
  "claude-opus-5-5": flat("4", "20", "0.20", "5", "8"),
  "claude-opus-5": flat("5", "25", "0.50", "6.25", "10"),
  "claude-opus-4-8": flat("5", "25", "0.50", "6.25", "10"),
  "claude-opus-4-7": flat("5", "25", "0.50", "6.25", "10"),
  "claude-opus-4-6": flat("5", "25", "0.50", "6.25", "10"),
  "claude-opus-4-5": flat("5", "25", "0.50", "6.25", "10"),
  // Cache reads on Sonnet 5.5 are 0.05x base input on the pricing page read that day.
  "claude-sonnet-5-5": flat("2", "10", "0.10", "2.50", "4"),
  "claude-sonnet-5": flat("2", "10", "0.20", "2.50", "4"),
  "claude-sonnet-4-6": flat("3", "15", "0.30", "3.75", "6"),
  "claude-haiku-5-5": {
    rates: rates("0.10", "0.50", "0.01", "0.125", "0.20"),
    longContext: {
      aboveTokens: 100_000,
      rates: rates("0.50", "2.50", "0.05", "0.625", "1"),
    },
  },
  "claude-haiku-4-5": flat("1", "5", "0.10", "1.25", "2"),
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

/** Published versions, oldest first. Append a new version; never edit a published one. */
export const PRICE_TABLES: readonly PriceTable[] = deepFreeze([
  {
    version: "2026-10-27",
    effectiveFrom: "2026-10-27T00:00:00Z",
    providers: {
      anthropic: {
        status: "verified",
        source: "https://platform.claude.com/docs/en/about-claude/pricing#model-pricing",
        retrieved: "2026-10-27",
        models: CLAUDE_API_2026_10_27,
      },
      // "Token usage rated in USD at standard per-model, per-feature rates (same as Claude API
      // pricing)" (pricing page, "Claude in Microsoft Foundry pricing"). US Data Zone deployments
      // pay 1.1x; Rocky cannot see the deployment type (ADR 0016, residual risk R3).
      foundry: {
        status: "verified",
        source:
          "https://platform.claude.com/docs/en/about-claude/pricing#claude-in-microsoft-foundry-pricing",
        retrieved: "2026-10-27",
        models: CLAUDE_API_2026_10_27,
      },
      // PLACEHOLDER (needs-human): Bedrock and Vertex AI are partner-priced; their pricing pages
      // did not yield per-model Claude rates when read on 2026-10-27, and regional endpoints add
      // a premium over global ones. Rows on these platforms record tokens with no price.
      bedrock: {
        status: "unverified",
        note: "https://aws.amazon.com/bedrock/pricing/ (partner pricing, not verified)",
      },
      vertex: {
        status: "unverified",
        note: "https://cloud.google.com/vertex-ai/generative-ai/pricing#claude-models (partner pricing, not verified)",
      },
      // A local server (Ollama, vLLM) has no list price.
      "openai-compatible": { status: "unverified", note: "no list price (self-hosted server)" },
    },
  },
] satisfies PriceTable[]);

/** The version in effect at `at`: the newest whose `effectiveFrom` is not after it. */
export const priceTableAt = (
  at: Date,
  tables: readonly PriceTable[] = PRICE_TABLES,
): PriceTable | undefined => {
  let found: PriceTable | undefined;
  for (const table of tables) {
    if (Date.parse(table.effectiveFrom) <= at.getTime()) found = table;
  }
  return found;
};

/** The verified price of `model` on `provider` in `table`; undefined when there is none. */
export const modelPrice = (
  table: PriceTable,
  provider: string,
  model: string,
): ModelPrice | undefined => {
  const prices = (table.providers as Readonly<Record<string, ProviderPrices | undefined>>)[
    provider
  ];
  if (prices?.status !== "verified") return undefined;
  return Object.hasOwn(prices.models, model) ? prices.models[model] : undefined;
};

/** Integer µUSD for `tokens` at `price`, rounded half up once. */
export const costMicroUsd = (price: ModelPrice, tokens: LlmUsageTokens): number => {
  const prompt =
    tokens.inputTokens +
    tokens.cacheReadTokens +
    tokens.cacheWrite5mTokens +
    tokens.cacheWrite1hTokens;
  const card =
    price.longContext !== undefined && prompt > price.longContext.aboveTokens
      ? price.longContext.rates
      : price.rates;
  const scaled =
    BigInt(tokens.inputTokens) * card.input +
    BigInt(tokens.outputTokens) * card.output +
    BigInt(tokens.cacheReadTokens) * card.cacheRead +
    BigInt(tokens.cacheWrite5mTokens) * card.cacheWrite5m +
    BigInt(tokens.cacheWrite1hTokens) * card.cacheWrite1h;
  return Number((scaled + 500_000n) / 1_000_000n);
};
