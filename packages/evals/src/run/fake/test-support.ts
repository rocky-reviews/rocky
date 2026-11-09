/**
 * The `--fake` target (P4-7): scripted roles, no network, no spending, deterministic. It exists
 * to test the eval harness itself (CI runs it on every change); its scores measure the scripts,
 * never a model. Named `test-support` because it loads the scripted LLM fake, which only tests
 * and test-support files may import; the CLI loads this module only for `--fake`.
 *
 * Seeded PRs get their decent-model script; injection cases get P4-4's adversary for the case's
 * goal (a fully compromised model), so the injection metrics are exercised with non-zero counts.
 * The Ask eval (P9-2) gets `ask/fake.ts`: a lexical embedder and a model that cites what it
 * was shown. Usage is a fixed estimate (a token per 4 characters in and out) so token accounting and the
 * cap are exercised too.
 */
import type { CompletionRoleClient, LlmRoles } from "@rocky-reviews/core";
import { scriptedRoles, type Script } from "@rocky-reviews/core/testing";
import { ADVERSARY_FOR_GOAL, adversaryScript } from "../../injection/adversary.js";
import { MEMORY_RUN_1, MEMORY_RUN_2, memoryFakeScript } from "../../memory/case.js";
import { askFakeScript, LEXICAL_SPACE, lexicalEmbedder } from "../../ask/fake.js";
import type { ReportModels } from "../report.js";
import type { AskEmbedding, EvalSubject } from "../runner.js";

const ROLES = ["triage", "review", "graph", "ask"] as const;

export const FAKE_MODELS: ReportModels = {
  ...Object.fromEntries(
    ROLES.map((role) => [role, { provider: "scripted", model: `scripted-${role}`, effort: null }]),
  ),
  embed: { provider: LEXICAL_SPACE.provider, model: LEXICAL_SPACE.model, effort: null },
};

const estimate = (text: string): number => Math.ceil(text.length / 4);

const withEstimatedUsage = (roles: LlmRoles): LlmRoles => ({
  completion: (role) => {
    const client = roles.completion(role);
    const complete: CompletionRoleClient["complete"] = async (request) => {
      const result = await client.complete(request);
      const input =
        request.instructions.text.length +
        request.untrusted.reduce((n, part) => n + part.text.length, 0);
      const output = "value" in result ? (JSON.stringify(result.value) ?? "") : "";
      return {
        ...result,
        usage: {
          inputTokens: Math.ceil(input / 4),
          outputTokens: estimate(output),
          cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
          cacheWrite5mInputTokens: result.usage?.cacheWrite5mInputTokens ?? 0,
          cacheWrite1hInputTokens: result.usage?.cacheWrite1hInputTokens ?? 0,
        },
      };
    };
    return { role, complete };
  },
  embedding: () => roles.embedding(),
});

const scriptFor = (subject: EvalSubject): Script =>
  subject.kind === "ask"
    ? askFakeScript
    : subject.kind === "seeded"
      ? subject.pr.fake
      : subject.kind === "memory"
        ? memoryFakeScript(subject.step === "learn" ? MEMORY_RUN_1 : MEMORY_RUN_2)
        : adversaryScript(
            ADVERSARY_FOR_GOAL[subject.case.goal],
            subject.case.trigger,
            { compromised: [] },
            subject.fixture,
          );

/** P9-2: the Ask eval embeds with a bag of words (`ask/fake.ts`). */
const FAKE_ASK: AskEmbedding = { client: lexicalEmbedder(), space: LEXICAL_SPACE };

export const fakeTarget = () => ({
  models: FAKE_MODELS,
  ask: FAKE_ASK,
  rolesFor: (subject: EvalSubject): LlmRoles =>
    withEstimatedUsage(scriptedRoles(scriptFor(subject)).roles),
});
export type FakeTarget = ReturnType<typeof fakeTarget>;
