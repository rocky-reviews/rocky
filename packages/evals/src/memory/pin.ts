/**
 * Pinned triage for the memory eval (P8-2, fix round 3). The eval measures memory, not triage:
 * whether a dismissed pattern stays out, the entry is cited and the real bug is still found. A
 * live run showed triage variance breaking the count (ADR 0037 §6: the same file triaged
 * `important` in one trial and `critical` in the next, where no suppression stands by design).
 *
 * This is an eval-harness option, not product behaviour: the triage model is still called, its
 * answer is recorded per file (`answered`, a diagnostic the report keeps as `modelLevel`), and
 * the level the pipeline sees is replaced by the pinned one, with the score moved into that
 * level's band so the document's integrity rule (SCORE_LEVEL_MISMATCH) holds. Nothing else in
 * the answer changes; a result that is not `ok` passes through.
 */
import type { CompletionRoleClient, LlmRoles } from "@rocky-reviews/core";
import { limits } from "@rocky-reviews/schema";

export type PinnedLevel = "critical" | "important" | "normal" | "low";

const { SCORE_BANDS } = limits;
const LEVELS = new Set<string>(Object.keys(SCORE_BANDS));
const isLevel = (value: unknown): value is PinnedLevel =>
  typeof value === "string" && LEVELS.has(value);

export interface TriagePin {
  readonly roles: LlmRoles;
  /** The level the triage model answered per file path, before the pin (the last answer). */
  readonly answered: ReadonlyMap<string, PinnedLevel>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const pinTriage = (roles: LlmRoles, level: PinnedLevel): TriagePin => {
  const answered = new Map<string, PinnedLevel>();
  const band = SCORE_BANDS[level];
  const pinned = (client: CompletionRoleClient): CompletionRoleClient => ({
    role: client.role,
    complete: async (request) => {
      const result = await client.complete(request);
      if (result.status !== "ok" || !isRecord(result.value) || !isLevel(result.value["level"]))
        return result;
      const path = request.untrusted.find((part) => part.label === "file_path")?.text;
      if (path !== undefined) answered.set(path, result.value["level"]);
      const score = result.value["score"];
      return {
        ...result,
        value: {
          ...result.value,
          level,
          ...(typeof score === "number"
            ? { score: Math.min(Math.max(score, band.min), band.max) }
            : {}),
        } as typeof result.value,
      };
    },
  });
  return {
    answered,
    roles: {
      completion: (role) =>
        role === "triage" ? pinned(roles.completion(role)) : roles.completion(role),
      embedding: () => roles.embedding(),
    },
  };
};
