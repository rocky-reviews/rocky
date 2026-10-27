import {
  FINAL_INSTRUCTION,
  LLM_COMPLETION_ROLES,
  UNTRUSTED_PREAMBLE,
  type LlmCompletionRole,
  type LlmRoles,
  type LlmUsage,
  type StructuredCompletionRequest,
} from "@rocky-reviews/core";

/**
 * The CLI's spend cap (P4-8): a token budget per run, wrapped around the `LlmRoles` handed to the
 * pipeline, so every model call goes through it. It is a **best-effort stop before the next
 * call**, not a hard ceiling on what the provider bills.
 *
 * Before a call: refuse it when the usage reported so far, plus what calls still in flight may
 * use, plus this call's reservation would exceed the cap. Calls run in parallel (the pipeline's
 * per-file lanes), so in-flight calls hold their reservation until they answer; without it four
 * calls could each pass the check and overshoot together. Once one call is refused, every later
 * call is refused too, and the run stops.
 *
 * A call's reservation is its input estimate, once per attempt that could bill the input (a
 * server-side refusal fallback re-runs the call on another model inside the same `complete()`),
 * plus its `maxOutputTokens`. The input estimate counts one token per UTF-8 byte of everything
 * sent (prompt, content, output schema): no byte-level tokenizer spends more, so dense text (CJK,
 * emoji, base64, minified code) that a PR author controls cannot make it an underestimate. For
 * ordinary code and prose it is several times the real count.
 *
 * After a call: the reservation is replaced by the usage the provider reported (input, output,
 * cache reads and writes; every attempt when a refusal fallback re-ran it). One call can still
 * exceed its reservation (the provider's own prompt overhead, a fallback chain longer than
 * assumed), so the cap can be overshot by that call; the next call is then refused. A call that
 * throws reports nothing, so it releases its reservation; the provider may still have billed part
 * of it. Pricing the usage is P4-5's (`UsageReport` keeps provider and models per role for it).
 */

/** Thrown at a refused call. The pipeline turns it into a failure; the CLI reads `report()`. */
export class TokenCapReached extends Error {
  override readonly name = "TokenCapReached";
  constructor() {
    super("token cap reached");
  }
}

export interface RoleUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  /** 5-minute and 1-hour cache writes together. */
  readonly cacheWriteInputTokens: number;
  readonly totalTokens: number;
  /** Attempts whose provider reported no (valid) usage; the cap charged their reservation. */
  readonly unreported: number;
  /** The provider that served the role (stamped by the registry). */
  readonly provider: string | undefined;
  /** Every model that answered (a refusal fallback can switch models). */
  readonly models: readonly string[];
}

export interface CapStop {
  readonly role: LlmCompletionRole;
  /** Reported usage when the call was refused. */
  readonly usedTokens: number;
  /** Held by calls still in flight. */
  readonly reservedTokens: number;
  /** The refused call's reservation: input ceiling per attempt plus `maxOutputTokens`. */
  readonly nextCallTokens: number;
  readonly cap: number;
}

export interface UsageReport {
  readonly cap: number;
  readonly roles: Readonly<Record<LlmCompletionRole, RoleUsage>>;
  readonly totalTokens: number;
  readonly stopped: CapStop | undefined;
}

export interface TokenBudget {
  readonly roles: LlmRoles;
  report(): UsageReport;
}

/** Rocky's delimiters around each untrusted part (ids, labels, markers), in bytes. */
const PART_OVERHEAD_BYTES = 96;
const encoder = new TextEncoder();
/** UTF-8 bytes: an upper bound on the tokens a byte-level tokenizer spends on `text`. */
const bytes = (text: string): number => encoder.encode(text).byteLength;
const FIXED_PROMPT_BYTES = bytes(UNTRUSTED_PREAMBLE) + bytes(FINAL_INSTRUCTION);

/** An input ceiling for one call, in tokens: prompt, delimiters, content and output schema. */
export const estimateInputTokens = (request: StructuredCompletionRequest<unknown>): number =>
  FIXED_PROMPT_BYTES +
  bytes(request.instructions.text) +
  request.untrusted.reduce(
    (sum, part) => sum + PART_OVERHEAD_BYTES + bytes(part.label) + bytes(part.text),
    0,
  ) +
  bytes(JSON.stringify(request.output.jsonSchema));

const usageTokens = (usage: LlmUsage) => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadInputTokens: usage.cacheReadInputTokens,
  cacheWriteInputTokens: usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens,
});

interface Tally {
  calls: number;
  unreported: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  provider: string | undefined;
  models: Set<string>;
}

const totalOf = (tally: Omit<Tally, "calls" | "unreported" | "provider" | "models">): number =>
  tally.inputTokens + tally.outputTokens + tally.cacheReadInputTokens + tally.cacheWriteInputTokens;

export interface TokenCapOptions {
  /**
   * How many times a role's call can bill its input: 2 where a server-side refusal fallback can
   * re-run it (`inputAttemptsFor` in config.ts), 1 otherwise (the default).
   */
  readonly inputAttempts?: (role: LlmCompletionRole) => number;
}

export const withTokenCap = (
  roles: LlmRoles,
  cap: number,
  options: TokenCapOptions = {},
): TokenBudget => {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new RangeError("the token cap must be a positive integer");
  }
  const inputAttempts = (role: LlmCompletionRole): number => {
    const attempts = options.inputAttempts?.(role) ?? 1;
    if (!Number.isSafeInteger(attempts) || attempts < 1) {
      throw new RangeError("input attempts must be a positive integer");
    }
    return attempts;
  };
  for (const role of LLM_COMPLETION_ROLES) inputAttempts(role);
  const tallies = new Map<LlmCompletionRole, Tally>(
    LLM_COMPLETION_ROLES.map((role) => [
      role,
      {
        calls: 0,
        unreported: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        provider: undefined,
        models: new Set<string>(),
      },
    ]),
  );
  let used = 0;
  let reserved = 0;
  let stopped: CapStop | undefined;

  const wrapped: LlmRoles = {
    completion: (role) => {
      const client = roles.completion(role);
      const tally = tallies.get(role) as Tally;
      return {
        role,
        complete: async (request) => {
          const next = estimateInputTokens(request) * inputAttempts(role) + request.maxOutputTokens;
          if (stopped !== undefined || used + reserved + next > cap) {
            stopped ??= {
              role,
              usedTokens: used,
              reservedTokens: reserved,
              nextCallTokens: next,
              cap,
            };
            throw new TokenCapReached();
          }
          reserved += next;
          let result;
          try {
            result = await client.complete(request);
          } finally {
            reserved -= next;
          }
          const attempts = result.attempts?.map((attempt) => attempt.usage) ?? [result.usage];
          tally.calls++;
          tally.provider = result.provider;
          for (const attempt of result.attempts ?? [{ model: result.model }]) {
            tally.models.add(attempt.model);
          }
          for (const usage of attempts) {
            // A provider that reported no (valid) usage (P4-5): the cap counts the whole
            // reservation for it, never zero; the per-role tallies show only reported tokens.
            if (usage === undefined) {
              tally.unreported++;
              used += next;
              continue;
            }
            const tokens = usageTokens(usage);
            tally.inputTokens += tokens.inputTokens;
            tally.outputTokens += tokens.outputTokens;
            tally.cacheReadInputTokens += tokens.cacheReadInputTokens;
            tally.cacheWriteInputTokens += tokens.cacheWriteInputTokens;
            used += totalOf(tokens);
          }
          return result;
        },
      };
    },
    // The pipeline embeds nothing; an unmetered embedding client must not slip past the cap.
    embedding: () => undefined,
  };

  const report = (): UsageReport => {
    const byRole = Object.fromEntries(
      [...tallies].map(([role, tally]) => [
        role,
        {
          calls: tally.calls,
          inputTokens: tally.inputTokens,
          outputTokens: tally.outputTokens,
          cacheReadInputTokens: tally.cacheReadInputTokens,
          cacheWriteInputTokens: tally.cacheWriteInputTokens,
          totalTokens: totalOf(tally),
          unreported: tally.unreported,
          provider: tally.provider,
          models: [...tally.models],
        } satisfies RoleUsage,
      ]),
    ) as unknown as Record<LlmCompletionRole, RoleUsage>;
    return { cap, roles: byRole, totalTokens: used, stopped };
  };

  return { roles: wrapped, report };
};
