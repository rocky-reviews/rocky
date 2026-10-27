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
export {
  findingMatches,
  LINE_SLACK,
  severityCompatible,
  type SeededFinding,
  type Severity,
} from "./score.js";
export { SEEDED_PRS, type SeededPr } from "./seeded/index.js";
export {
  DEFAULT_MAX_TOKENS,
  evalsCli,
  type CliDeps,
  type CliIo,
  type LiveTarget,
} from "./run/cli.js";
export {
  compareReports,
  CRITICAL_RATE_TOLERANCE,
  PlaceholderBaselineError,
  RECALL_DROP_POINTS,
  type Comparison,
} from "./run/compare.js";
export {
  EvalReport,
  parseReport,
  PLACEHOLDER_NOTICE,
  PROMPT_HASH,
  REPORT_FORMAT,
  REPORT_VERSION,
  type ReportModels,
} from "./run/report.js";
export { runEvals, type EvalSubject, type RunOptions } from "./run/runner.js";
