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
 * pipeline, so every model call goes through it.
 *
 * Before a call: refuse it when the usage reported so far, plus what calls still in flight may
 * use, plus this call's input estimate and its `maxOutputTokens`, would exceed the cap. Calls run
 * in parallel (the pipeline's per-file lanes), so in-flight calls hold a reservation until they
 * answer; without it four calls could each pass the check and overshoot together. Once one call is
 * refused, every later call is refused too, and the run stops.
 *
 * After a call: the reservation is replaced by the usage the provider reported (input, output,
 * cache reads and writes; every attempt when a refusal fallback re-ran it). A call that throws
 * reports nothing, so it releases its reservation; the provider may still have billed part of it.
 *
 * The input estimate is deliberately rough (characters / 3, plus the fixed prompt text and the
 * output schema): prose and code average more characters per token, so it overestimates.
 * Pricing the usage is P4-5's (`UsageReport` keeps provider and models per role for it).
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
  /** The refused call's input estimate plus its `maxOutputTokens`. */
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

const CHARS_PER_TOKEN = 3;
/** Rocky's delimiters around each untrusted part (ids, labels, markers). */
const PART_OVERHEAD_CHARS = 96;
const FIXED_PROMPT_CHARS = UNTRUSTED_PREAMBLE.length + FINAL_INSTRUCTION.length;

/** Characters of fixed prompt and delimiters, for `estimateTokens`. */
export const promptChars = (instructionChars: number, parts: number): number =>
  FIXED_PROMPT_CHARS + instructionChars + parts * PART_OVERHEAD_CHARS;

export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/** A rough, high input estimate for one call: prompt, content and output schema. */
export const estimateInputTokens = (request: StructuredCompletionRequest<unknown>): number =>
  estimateTokens(
    promptChars(request.instructions.text.length, request.untrusted.length) +
      request.untrusted.reduce((sum, part) => sum + part.label.length + part.text.length, 0) +
      JSON.stringify(request.output.jsonSchema).length,
  );

const usageTokens = (usage: LlmUsage) => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadInputTokens: usage.cacheReadInputTokens,
  cacheWriteInputTokens: usage.cacheWrite5mInputTokens + usage.cacheWrite1hInputTokens,
});

interface Tally {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  provider: string | undefined;
  models: Set<string>;
}

const totalOf = (tally: Omit<Tally, "calls" | "provider" | "models">): number =>
  tally.inputTokens + tally.outputTokens + tally.cacheReadInputTokens + tally.cacheWriteInputTokens;

export const withTokenCap = (roles: LlmRoles, cap: number): TokenBudget => {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new RangeError("the token cap must be a positive integer");
  }
  const tallies = new Map<LlmCompletionRole, Tally>(
    LLM_COMPLETION_ROLES.map((role) => [
      role,
      {
        calls: 0,
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
          const next = estimateInputTokens(request) + request.maxOutputTokens;
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
          provider: tally.provider,
          models: [...tally.models],
        } satisfies RoleUsage,
      ]),
    ) as unknown as Record<LlmCompletionRole, RoleUsage>;
    return { cap, roles: byRole, totalTokens: used, stopped };
  };

  return { roles: wrapped, report };
};
