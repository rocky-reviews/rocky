/**
 * The analysis document: one per PR revision, the only AI output the UI, renderer, posting and
 * metering read (ADR 0004). PR metadata and diff content come from the GitHub mirror.
 *
 * Versioning (SCHEMA_VERSION, SUPPORTED_VERSION_PATTERN, isSupportedVersion, SchemaVersionField)
 * adapted from PR Lens (https://github.com/coldteadotai/pr-lens), MIT License,
 * Copyright (c) 2026 Coldtea AI. See NOTICE.
 */
import { z } from "zod";
import { Briefing } from "./briefing.js";
import { Findings } from "./findings.js";
import { Graph } from "./graph.js";
import { Provenance } from "./provenance.js";
import { Triage } from "./triage.js";

/**
 * Contract version carried by every document. Patch and minor releases only add optional
 * fields or widen an enum; a major release may remove or retype a field.
 */
export const SCHEMA_VERSION = "1.0.0" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

const [currentMajor = "1", currentMinor = "0"] = SCHEMA_VERSION.split(".");

/**
 * Which versions this package reads. A newer minor than this package knows is refused: it may
 * carry a field this parser would reject as invented.
 */
export const SUPPORTED_VERSION_PATTERN = `^${currentMajor}\\.(${currentMinor})\\.\\d+$`;

export const isSupportedVersion = (version: string): boolean =>
  new RegExp(SUPPORTED_VERSION_PATTERN).test(version);

export const SchemaVersionField = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be a semver string, e.g. 1.0.0")
  .meta({ pattern: SUPPORTED_VERSION_PATTERN })
  .describe(`Contract version the document targets. Current: ${SCHEMA_VERSION}.`);

/**
 * What a model is asked to produce: everything except the known facts and the version, which
 * `applyKnownFields` adds from git and the pipeline.
 */
export const AnalysisModelOutput = z
  .strictObject({
    briefing: Briefing,
    triage: Triage,
    findings: Findings,
    graph: Graph.optional().describe("Absent when the change map could not be produced."),
  })
  .describe("The model-authored part of an analysis document.");
export type AnalysisModelOutput = z.infer<typeof AnalysisModelOutput>;
export type AnalysisModelOutputInput = z.input<typeof AnalysisModelOutput>;

export const AnalysisDocument = AnalysisModelOutput.safeExtend({
  schemaVersion: SchemaVersionField,
  provenance: Provenance,
})
  // The pipeline records why the change map is missing only when it is missing; a document
  // that carries both a graph and that reason would leave the UI two stories to choose from.
  .refine((doc) => doc.graph === undefined || doc.provenance.graphUnavailable === undefined, {
    message: "a document with a graph cannot also say the change map is unavailable",
    path: ["provenance", "graphUnavailable"],
  })
  .describe("A Rocky Reviews analysis document: one PR revision, fully analysed.");
export type AnalysisDocument = z.infer<typeof AnalysisDocument>;
export type AnalysisDocumentInput = z.input<typeof AnalysisDocument>;
