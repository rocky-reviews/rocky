import { createHash } from "node:crypto";
import {
  analyzePullRequest,
  ForgeReadError,
  isLlmCallError,
  type Clock,
  type Forge,
  type ForgeDiff,
  type ForgePullRequest,
  type LlmRoles,
} from "@rocky-reviews/core";
import { parseAnalysisDocumentJson } from "@rocky-reviews/schema";
import { ANALYSIS_DIFF_MAX_BYTES } from "../analysis.js";
import type { AnalyzeArgs } from "./args.js";
import { withTokenCap } from "./budget.js";
import { planAnalysis } from "./plan.js";
import {
  renderBriefing,
  renderCapStop,
  renderPlan,
  renderUsage,
  type PullRequestHeader,
  type UsagePricer,
} from "./render.js";
import { terminalJson } from "./terminal.js";

/**
 * `pnpm rocky analyze <owner/repo>#<n>` (P4-8): one pull request through the analysis pipeline,
 * the briefing printed in the terminal. For judging review quality on real PRs before the UI.
 *
 * - **Read-only.** The forge is asked for reads only: locate the repository (the app's
 *   installation), open a repository session (a token minted read-only for that one repository),
 *   read the pull request and its diff, close the session (the token is revoked). Nothing is
 *   posted, commented or stored; there is no database.
 * - **Spend cap.** Every model call goes through `withTokenCap`: the run stops before the call
 *   that could cross `--max-tokens`, exits `EXIT.capReached` and prints the usage so far.
 * - **Output.** The document is validated against the schema again before anything is printed.
 *   Every untrusted string is escaped for the terminal. `--json` prints the document itself.
 * - **No logging of content.** Errors go to stderr as fixed codes and fixed text; the briefing on
 *   stdout is the product output, not a log.
 */

export const EXIT = { ok: 0, failed: 1, usage: 2, capReached: 3 } as const;

export interface AnalyzeCommandDeps {
  readonly forge: Forge;
  /** Built only when a model call is about to be made: a dry run never builds the roles. */
  readonly llm: () => LlmRoles;
  readonly clock: Clock;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly unitKeySalt?: string;
  readonly maxDiffBytes?: number;
  /** P4-5 seam: prices the usage; undefined until the price table exists. */
  readonly price?: UsagePricer;
}

const sha256Hex = (text: string): string => createHash("sha256").update(text).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true });

class Refused extends Error {
  constructor(readonly text: string) {
    super(text);
  }
}

interface Read {
  readonly pullRequest: ForgePullRequest;
  readonly diff: ForgeDiff;
}

const read = async (deps: AnalyzeCommandDeps, args: AnalyzeArgs): Promise<Read> => {
  const notInstalled = `the GitHub App is not installed on ${args.fullName}, or cannot read it`;
  const ref = await deps.forge.locateRepository(args.fullName);
  if (ref === null) throw new Refused(notInstalled);
  const session = await deps.forge.openRepository(ref);
  if (session === null) throw new Refused(notInstalled);
  try {
    const pullRequest = await session.getPullRequest(args.number);
    if (pullRequest === null) {
      throw new Refused(`no pull request #${args.number} in ${args.fullName}`);
    }
    const diff = await session.getDiff(
      { baseSha: pullRequest.baseSha, headSha: pullRequest.headSha },
      { maxBytes: deps.maxDiffBytes ?? ANALYSIS_DIFF_MAX_BYTES },
    );
    return { pullRequest, diff };
  } finally {
    await session.close();
  }
};

export const runAnalyzeCommand = async (
  deps: AnalyzeCommandDeps,
  args: AnalyzeArgs,
): Promise<number> => {
  const fail = (text: string): number => {
    deps.err(`rocky: ${text}\n`);
    return EXIT.failed;
  };

  let fetched: Read;
  try {
    fetched = await read(deps, args);
  } catch (error) {
    if (error instanceof Refused) return fail(error.text);
    if (error instanceof ForgeReadError) return fail(`reading GitHub failed: ${error.code}`);
    return fail("reading GitHub failed: internal_error");
  }
  const { pullRequest, diff } = fetched;
  if (diff.truncation === "unavailable") return fail("analysis failed: diff_unavailable");
  let text: string;
  try {
    text = utf8.decode(diff.bytes);
  } catch {
    return fail("analysis failed: diff_not_utf8");
  }
  const header: PullRequestHeader = {
    fullName: args.fullName,
    number: args.number,
    title: pullRequest.title,
    state: pullRequest.state,
  };

  if (args.dryRun) {
    const plan = planAnalysis(text, pullRequest.title, diff.truncated);
    if (!plan.ok) return fail(`analysis would fail: ${plan.code}`);
    deps.out(renderPlan(plan, header, args.maxTokens));
    return EXIT.ok;
  }

  const budget = withTokenCap(deps.llm(), args.maxTokens);
  const usage = () => renderUsage(budget.report(), deps.price);
  let outcome;
  try {
    outcome = await analyzePullRequest(
      {
        repo: { owner: args.owner, name: args.name },
        pullRequest: { number: args.number, title: pullRequest.title },
        base: { sha: pullRequest.baseSha },
        head: { sha: pullRequest.headSha },
        diff: text,
        diffTruncated: diff.truncated,
      },
      {
        llm: budget.roles,
        clock: deps.clock,
        sha256Hex,
        generator: { name: "rocky" },
        ...(deps.unitKeySalt === undefined ? {} : { unitKeySalt: deps.unitKeySalt }),
      },
    );
  } catch (error) {
    // Retryable provider errors and cancellation are thrown by the pipeline (the queue retries
    // them); here a person retries. The message is the kind's fixed text, never a provider body.
    if (budget.report().stopped !== undefined) {
      deps.err(renderCapStop(budget.report()) + usage());
      return EXIT.capReached;
    }
    deps.err(
      isLlmCallError(error)
        ? `rocky: analysis stopped: llm_${error.kind} (${error.message}); try again later\n`
        : "rocky: analysis stopped: internal_error\n",
    );
    deps.err(usage());
    return EXIT.failed;
  }
  // A refused call surfaces from the pipeline as a failure; the budget knows why.
  if (budget.report().stopped !== undefined) {
    deps.err(renderCapStop(budget.report()) + usage());
    return EXIT.capReached;
  }
  if (outcome.status === "failed") {
    deps.err(`rocky: analysis failed: ${outcome.code}\n${usage()}`);
    return EXIT.failed;
  }

  // Validated again, whole, before anything reaches the terminal.
  const parsed = parseAnalysisDocumentJson(JSON.stringify(outcome.document));
  if (!parsed.ok) {
    deps.err(`rocky: analysis failed: document_invalid\n${usage()}`);
    return EXIT.failed;
  }
  if (args.json) {
    deps.out(`${terminalJson(parsed.value)}\n`);
    deps.err(usage());
  } else {
    deps.out(`${renderBriefing(parsed.value, header)}\n${usage()}`);
  }
  return EXIT.ok;
};
