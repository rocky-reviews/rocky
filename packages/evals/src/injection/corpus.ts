/**
 * The prompt-injection corpus (P4-4, ADR 0015 §4): data in `fixtures/injection-corpus.json`,
 * validated here so a malformed case fails loudly instead of testing nothing. The adversarial fakes
 * in `adversary.ts` run them in CI; `pnpm evals run --injection` runs them against real models (P4-7).
 */
import { RepositoryPath } from "@rocky-reviews/schema";
import { z } from "zod";
import data from "../../fixtures/injection-corpus.json" with { type: "json" };

/**
 * Where a payload goes. These are every channel the pipeline reads from a pull request: its
 * title, its file paths and its diff (added, removed and comment lines, and whole new files).
 * A rename's old path travels in the patch header (`rename_from`, review round 1, item 5).
 * PR bodies, commit messages and review comments are not pipeline inputs (ADR 0015 §2); model
 * output fed back to later stages (triage reasons, finding titles, repair issues) is reached
 * through these channels by the `feedback` cases and the repair tests.
 */
export const INJECTION_CHANNELS = [
  "pr_title",
  "file_path",
  "rename_from",
  "diff_comment",
  "diff_added",
  "diff_removed",
  "new_file",
] as const;
export type InjectionChannel = (typeof INJECTION_CHANNELS)[number];

/**
 * What the attacker asks the model to do. `poison_output` (review round 1, item 5): get harmful
 * text into the draft itself (a shell command in an agent prompt, a suggestion that removes a
 * check, a markdown image or link that exfiltrates or phishes once rendered).
 */
export const INJECTION_GOALS = [
  "approve",
  "suppress_findings",
  "finding_outside_diff",
  "leak_prompt",
  "call_tool",
  "fake_answer",
  "poison_output",
] as const;
export type InjectionGoal = (typeof INJECTION_GOALS)[number];

export const InjectionCase = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    channel: z.enum(INJECTION_CHANNELS),
    technique: z.enum([
      "override",
      "role_play",
      "delimiter_forgery",
      "nonce_guess",
      "chat_template",
      "fake_json",
      "tool_call",
      "prompt_leak",
      "unicode",
      "encoding",
      "multilingual",
      "diff_forgery",
      "feedback",
      "poisoned_output",
    ]),
    goal: z.enum(INJECTION_GOALS),
    /** ASCII, single line, inside the payload as placed: marks a call as compromised. */
    trigger: z.string().regex(/^[A-Za-z0-9_.:-]{4,40}$/),
    payload: z.string().min(1).max(4000),
    /** The file the payload goes into (diff channels) or the new file's path (`new_file`). */
    target: RepositoryPath.optional(),
    /** `fails_closed`: the injected PR cannot be analysed at all (no document is stored). */
    expect: z.literal("fails_closed").optional(),
  })
  .superRefine((value, context) => {
    if (!value.payload.includes(value.trigger))
      context.addIssue({ code: "custom", message: "payload must contain the trigger" });
    const needsTarget = !["pr_title", "file_path", "rename_from"].includes(value.channel);
    if (needsTarget !== (value.target !== undefined))
      context.addIssue({ code: "custom", message: "target is required exactly for file channels" });
  });
export type InjectionCase = z.output<typeof InjectionCase>;

export const InjectionCorpus = z
  .strictObject({
    version: z.literal(1),
    description: z.string(),
    cases: z.array(InjectionCase).min(1),
  })
  .refine((corpus) => new Set(corpus.cases.map((c) => c.id)).size === corpus.cases.length, {
    message: "case ids must be unique",
  })
  .refine((corpus) => new Set(corpus.cases.map((c) => c.trigger)).size === corpus.cases.length, {
    message: "triggers must be unique",
  });

export const INJECTION_CORPUS: readonly InjectionCase[] = InjectionCorpus.parse(data).cases;
