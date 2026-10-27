/**
 * A scripted `LlmRoles` for tests and evals (P4-3): no network, no provider, no spending, and
 * deterministic. It behaves like an adapter where the pipeline can tell: instructions must be
 * `RockyInstructions` and labels Rocky-authored, or the call is refused as `invalid_request`; an
 * answer goes through JSON text and the request's own validator, so a scripted answer that does
 * not match the output contract comes back `invalid_output` with path-only issues.
 *
 * The script sees each call's role, labels and untrusted parts, which is all a real model sees
 * besides the instructions. Real model quality is measured by P4-7 and P4-8, not here.
 */
import {
  isRockyInstructions,
  LlmCallError,
  type CompletionRoleClient,
  type LlmCompletionRole,
  type LlmRoles,
  type LlmUntrustedText,
  type LlmUsage,
  type RockyInstructions,
  type StructuredCompletionRequest,
  type StructuredCompletionResult,
} from "../llm.js";

export type ScriptedAnswer =
  | { readonly value: unknown }
  | { readonly status: "refused" | "truncated" }
  | { readonly status: "invalid_output"; readonly issues?: readonly string[] }
  | { readonly error: LlmCallError };

export interface ScriptedCall {
  readonly role: LlmCompletionRole;
  readonly instructions: RockyInstructions;
  readonly untrusted: readonly LlmUntrustedText[];
  readonly labels: readonly string[];
  /** The call carries a repair round's issue list. */
  readonly repair: boolean;
  readonly maxOutputTokens: number;
  /** The text of the part with this label, if any. */
  part(label: string): string | undefined;
}

export type Script = (call: ScriptedCall) => ScriptedAnswer | Promise<ScriptedAnswer>;

export interface ScriptedRoles {
  readonly roles: LlmRoles;
  /** Every call, in the order it was made. */
  readonly calls: ScriptedCall[];
}

const LABEL = /^[a-z][a-z0-9_.:-]{0,63}$/;
const ZERO: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWrite1hInputTokens: 0,
};

export const scriptedRoles = (
  script: Script,
  options: {
    readonly provider?: string;
    readonly model?: (role: LlmCompletionRole) => string;
  } = {},
): ScriptedRoles => {
  const calls: ScriptedCall[] = [];
  const provider = options.provider ?? "scripted";
  const model = options.model ?? ((role) => `scripted-${role}`);

  const client = (role: LlmCompletionRole): CompletionRoleClient => ({
    role,
    complete: async <T>(
      request: StructuredCompletionRequest<T>,
    ): Promise<StructuredCompletionResult<T>> => {
      if (request.signal?.aborted === true) throw new LlmCallError("cancelled");
      if (!isRockyInstructions(request.instructions)) throw new LlmCallError("invalid_request");
      if (!request.untrusted.every((part) => LABEL.test(part.label))) {
        throw new LlmCallError("invalid_request");
      }
      const labels = request.untrusted.map((part) => part.label);
      const call: ScriptedCall = {
        role,
        instructions: request.instructions,
        untrusted: request.untrusted,
        labels,
        repair: labels.includes("validation_issues"),
        maxOutputTokens: request.maxOutputTokens,
        part: (label) => request.untrusted.find((part) => part.label === label)?.text,
      };
      calls.push(call);
      const answer = await script(call);
      const base = { model: model(role), usage: ZERO, provider };
      if ("error" in answer) throw answer.error;
      if ("status" in answer) {
        return answer.status === "invalid_output"
          ? {
              ...base,
              status: "invalid_output",
              ...(answer.issues === undefined ? {} : { issues: answer.issues }),
            }
          : { ...base, status: answer.status };
      }
      const parsed = request.output.parse(JSON.parse(JSON.stringify(answer.value)) as unknown);
      return parsed.success
        ? { ...base, status: "ok", value: parsed.data }
        : { ...base, status: "invalid_output", issues: parsed.issues };
    },
  });

  return {
    roles: { completion: client, embedding: () => undefined },
    calls,
  };
};
