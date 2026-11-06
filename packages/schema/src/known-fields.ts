/**
 * Known fields overlay (ADR 0004 §3, P1-4): facts are not the model's to state.
 *
 * Commit SHAs, the file list with its line counts and hunk ranges, the repository, the PR
 * number, the timestamp and the generator are written over whatever the model returned, from
 * values the pipeline derived from git. A model that invents a file can still name it in
 * triage or a finding, but the integrity checks then reject the document (UNKNOWN_FILE),
 * because the only file list that counts is the one written here.
 */
import { requiredSchemaVersion } from "./document.js";
import type { Provenance, ProvenanceInput } from "./provenance.js";

/** What the pipeline knows from git and its own configuration. The whole provenance section. */
export type KnownFacts = ProvenanceInput | Provenance;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Overwrite the fact-bearing fields of a model output with known facts. Takes `unknown`
 * because model output has not been validated yet; the result still has to go through
 * `parseAnalysisDocument`. A non-object input is returned as-is so the parser reports it.
 *
 * When the pipeline records that the change map is unavailable (`facts.graphUnavailable`), any
 * `graph` the model returned is dropped: the pipeline decides, as it does for `unanalysed`.
 * Otherwise a model could turn a failed graph into a failed review by returning a graph next to
 * the reason, and a missing graph never blocks the review (gate H2, #2). The project-memory
 * markers are pipeline-owned too (`findings[].restored`, 1.5; `hidden`, 1.6): a model cannot
 * mark a draft "dismissed by your team" or hide a finding, so both are dropped here (P8-2b fix
 * round 1), and the version is stamped from what remains.
 *
 * The facts object is copied, so later mutation of the caller's facts cannot leak into the
 * document.
 */
export const applyKnownFields = (modelOutput: unknown, facts: KnownFacts): unknown => {
  if (!isRecord(modelOutput)) return modelOutput;
  const result: Record<string, unknown> = { ...modelOutput };
  result.provenance = structuredClone(facts);
  delete result.hidden;
  if (Array.isArray(result.findings))
    result.findings = result.findings.map((finding: unknown) => {
      if (!isRecord(finding)) return finding;
      const copy = { ...finding };
      delete copy.restored;
      return copy;
    });
  result.schemaVersion = requiredSchemaVersion({
    briefing: result.briefing,
    findings: result.findings,
    provenance: facts,
  });
  if (facts.graphUnavailable !== undefined) delete result.graph;
  // The sections drawn by their own calls (schema 1.3, H4-7) follow the same rule: when the
  // pipeline recorded that one failed, whatever the model returned for it is dropped.
  if (isRecord(result.graph)) {
    const graph = { ...result.graph };
    if (facts.flowsUnavailable !== undefined) graph.flows = [];
    if (facts.walkthroughUnavailable !== undefined) delete graph.walkthrough;
    result.graph = graph;
  }
  return result;
};
