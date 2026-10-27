/**
 * One model call with validate-and-repair (ADR 0004 §2, ADR 0014 §5): the answer is validated;
 * on failure the issues (paths and codes only) go back to the model for at most
 * `MAX_REPAIR_ROUNDS` more calls; if it still fails, the unit fails and the caller records that
 * (an unanalysed file, an unavailable change map, a failed analysis). Nothing unvalidated leaves
 * this function, and the number of calls is bounded whatever the model answers.
 *
 * The issue list is built by Rocky but describes model output (paths can carry model-chosen keys),
 * so it goes in an `untrusted` part like PR content; the repair instruction is a literal.
 *
 * Every schema-valid answer also passes the leak guard (P4-4, ADR 0015 §3) before its integrity
 * check: an answer that copies Rocky's system prompt is repaired or fails like any invalid one.
 * The guard allows only text found in the call's own content, never in the issue list.
 */
import {
  isLlmCallError,
  joinInstructions,
  type LlmCompletionRole,
  type LlmOutputSchema,
  type LlmRoles,
  type LlmUntrustedText,
  type RockyInstructions,
  type StructuredCompletionResult,
} from "../llm.js";
import { REPAIR_INSTRUCTIONS } from "./instructions.js";
import { instructionLeaks } from "./leak.js";
import { MAX_REPAIR_ISSUES } from "./outputs.js";
import type { UnitCheck } from "./validate.js";

/** ADR 0004: one repair round. Each unit costs at most 1 + this many calls. */
export const MAX_REPAIR_ROUNDS = 1;

export const ISSUES_LABEL = "validation_issues";

/** Why a unit produced nothing usable. Fixed codes, mapped to the document's reasons. */
export type UnitFailure = "refused" | "truncated" | "invalid" | "too_large" | "timeout";

export type UnitResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: UnitFailure };

export interface StageCall<T> {
  readonly role: LlmCompletionRole;
  readonly instructions: RockyInstructions;
  readonly untrusted: readonly LlmUntrustedText[];
  readonly output: LlmOutputSchema<T>;
  readonly maxOutputTokens: number;
  /** Integrity beyond the output schema; `[]` accepts the answer. */
  readonly check: (value: T) => UnitCheck;
}

export interface CallObserver {
  /** Every call that reached the provider, with its result (for stats and generator roles). */
  onResult(
    role: LlmCompletionRole,
    result: StructuredCompletionResult<unknown>,
    repair: boolean,
  ): void;
}

export const completeWithRepair = async <T>(
  llm: LlmRoles,
  call: StageCall<T>,
  observer: CallObserver,
  signal: AbortSignal | undefined,
): Promise<UnitResult<T>> => {
  const client = llm.completion(call.role);
  let issues: readonly string[] = [];
  for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
    const repair = round > 0;
    let result: StructuredCompletionResult<T>;
    try {
      result = await client.complete<T>({
        instructions: repair
          ? joinInstructions([call.instructions, REPAIR_INSTRUCTIONS])
          : call.instructions,
        untrusted: repair
          ? [...call.untrusted, { label: ISSUES_LABEL, text: issues.join("\n") }]
          : call.untrusted,
        output: call.output,
        maxOutputTokens: call.maxOutputTokens,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      // Input that cannot fit is the unit's problem (P4-6 splits it); a timeout of one unit is
      // recorded as such. Everything else (retryable outages, account problems, cancellation)
      // belongs to the whole analysis and is the caller's to handle.
      if (isLlmCallError(error)) {
        if (error.kind === "context_too_long" || error.kind === "request_too_large") {
          return { ok: false, reason: "too_large" };
        }
        if (error.kind === "timeout") return { ok: false, reason: "timeout" };
      }
      throw error;
    }
    observer.onResult(call.role, result as StructuredCompletionResult<unknown>, repair);
    if (result.status === "invalid_output") {
      issues = result.issues?.length ? result.issues : ["(root): invalid_output"];
      continue;
    }
    if (result.status !== "ok") {
      // A refusal is a policy decision and a truncation an output-size problem: repeating the
      // same request with a list of issues fixes neither.
      return { ok: false, reason: result.status };
    }
    const checked = call.check(result.value);
    if (checked === "unrepairable") return { ok: false, reason: "invalid" };
    // `call.untrusted`, not this round's parts: the issue list must not allow a copy (A24).
    const found = [...instructionLeaks(result.value, call.untrusted), ...checked];
    if (found.length === 0) return { ok: true, value: result.value };
    issues = found.slice(0, MAX_REPAIR_ISSUES);
  }
  return { ok: false, reason: "invalid" };
};
