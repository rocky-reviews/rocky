export { scoreFindings, type FindingScore, type ScoredFinding } from "./score.js";
export { pr847Diff, ROUTES, ROUTES_PUSH_2 } from "./pr-847/diff.js";
export { PR847, pr847Script, REPAIRED_PATH } from "./pr-847/script.js";
export {
  INJECTION_CHANNELS,
  INJECTION_CORPUS,
  INJECTION_GOALS,
  InjectionCase,
  type InjectionChannel,
  type InjectionGoal,
} from "./injection/corpus.js";
export {
  CLEAN_TITLE,
  injectCase,
  injectionRequest,
  type InjectedPullRequest,
} from "./injection/inject.js";
export {
  findingViolations,
  findLeaks,
  PROMPT_LEAK_WINDOW,
  storedViolations,
  verdictFloor,
  verdictViolations,
} from "./injection/check.js";
export {
  ADVERSARIES,
  ADVERSARY_FOR_GOAL,
  adversaryScript,
  honestScript,
  type Adversary,
  type AdversaryLog,
} from "./injection/adversary.js";
