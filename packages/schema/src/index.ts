export * as limits from "./limits.js";

export {
  Confidence,
  Delta,
  FileRef,
  FullSha,
  hasForbiddenLineCharacters,
  hasForbiddenProseCharacters,
  Id,
  ID_PATTERN,
  LineNumber,
  LineRange,
  REPOSITORY_PATH_PATTERN,
  RepositoryPath,
  Score,
} from "./primitives.js";

export {
  byteLength,
  EdgeEmphasis,
  EdgeKind,
  Flow,
  FlowMessage,
  FlowParticipant,
  Graph,
  GraphEdge,
  GraphNode,
  jsonDepth,
  jsonHasForbiddenCharacters,
  JsonValue,
  Lane,
  MessageKind,
  NodeKind,
  Payload,
  PayloadSide,
  StepFocus,
  StepStage,
  View,
  ViewScope,
  Walkthrough,
  WalkthroughStep,
  type GraphInput,
  type ViewInput,
} from "./graph.js";

export {
  Flag,
  FlagKind,
  NoiseFile,
  Triage,
  TriagedFile,
  TriagedFileLevel,
  TriageLevel,
  type TriageInput,
} from "./triage.js";

export {
  Finding,
  Findings,
  MemoryRef,
  Severity,
  Suggestion,
  type FindingInput,
} from "./findings.js";

export { Briefing, ReviewPathStep, RiskLevel, Verdict, type BriefingInput } from "./briefing.js";

export {
  ChangedFile,
  FileStatus,
  Generator,
  GeneratorRole,
  GitRef,
  Hunk,
  LlmRole,
  Provenance,
  RepoName,
  RepoOwner,
  type ProvenanceInput,
} from "./provenance.js";

export {
  AnalysisDocument,
  AnalysisModelOutput,
  isSupportedVersion,
  SCHEMA_VERSION,
  SchemaVersionField,
  SUPPORTED_VERSION_PATTERN,
  type AnalysisDocumentInput,
  type AnalysisModelOutputInput,
  type SchemaVersion,
} from "./document.js";

export {
  formatIssues,
  formatPath,
  type IssueCode,
  type ParseError,
  type Parsed,
  type SchemaIssue,
} from "./errors.js";

export {
  integrityIssues,
  rangeInsideHunks,
  type FileLines,
  type IntegrityOptions,
} from "./integrity.js";

export { parseAnalysisDocument, type ParseOptions } from "./parse.js";

export { applyKnownFields, type KnownFacts } from "./known-fields.js";

export { buildJsonSchema, emitJsonSchema, JSON_SCHEMA_ID } from "./json-schema.js";
