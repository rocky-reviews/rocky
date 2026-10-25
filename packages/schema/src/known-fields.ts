/**
 * Known fields overlay (ADR 0004 §3, P1-4): facts are not the model's to state.
 *
 * Commit SHAs, the file list with its line counts and hunk ranges, the repository, the PR
 * number, the timestamp and the generator are written over whatever the model returned, from
 * values the pipeline derived from git. A model that invents a file can still name it in
 * triage or a finding, but the integrity checks then reject the document (UNKNOWN_FILE),
 * because the only file list that counts is the one written here.
 */
import { SCHEMA_VERSION } from "./document.js";
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
 * The facts object is copied, so later mutation of the caller's facts cannot leak into the
 * document.
 */
export const applyKnownFields = (modelOutput: unknown, facts: KnownFacts): unknown => {
  if (!isRecord(modelOutput)) return modelOutput;
  const result: Record<string, unknown> = { ...modelOutput };
  result.schemaVersion = SCHEMA_VERSION;
  result.provenance = structuredClone(facts);
  return result;
};
