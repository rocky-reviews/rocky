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
export const SCHEMA_VERSION = "1.5.0" as const;
export type SchemaVersion = typeof SCHEMA_VERSION;

/**
 * The version a document is stamped with: the lowest minor whose contract it uses (H4-5, review
 * round 1, S7), so a reader that only knows 1.1 still reads every document that needs nothing
 * newer. 1.2 added one value, `graphUnavailable.reason: "no-logic"`; 1.3 (H4-7) added the
 * pipeline-owned `provenance.flowsUnavailable` and `provenance.walkthroughUnavailable`; 1.4
 * (H4-8) added `briefing.tldr`, which may stand in for `briefing.summary`; 1.5 (P8-2, ADR 0037)
 * added the pipeline-owned `findings[].restored`. A document that uses none of them is a 1.1
 * document.
 */
export const BASE_SCHEMA_VERSION = "1.1.0" as const;
export const NO_LOGIC_SCHEMA_VERSION = "1.2.0" as const;
export const MAP_SECTIONS_SCHEMA_VERSION = "1.3.0" as const;
export const TLDR_SCHEMA_VERSION = "1.4.0" as const;
export type StampedSchemaVersion =
  | typeof BASE_SCHEMA_VERSION
  | typeof NO_LOGIC_SCHEMA_VERSION
  | typeof MAP_SECTIONS_SCHEMA_VERSION
  | typeof TLDR_SCHEMA_VERSION
  | SchemaVersion;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requiredSchemaVersion = (doc: {
  readonly briefing?: unknown;
  /** Unvalidated when the overlay stamps; only `restored` is looked at. */
  readonly findings?: unknown;
  readonly provenance?:
    | {
        readonly graphUnavailable?: { readonly reason?: unknown } | undefined;
        readonly flowsUnavailable?: unknown;
        readonly walkthroughUnavailable?: unknown;
      }
    | undefined;
}): StampedSchemaVersion => {
  // Only the pipeline writes `restored` (1.5); a finding that carries one needs the 1.5 reader.
  if (
    Array.isArray(doc.findings) &&
    doc.findings.some((finding) => isRecord(finding) && finding["restored"] !== undefined)
  )
    return SCHEMA_VERSION;
  // `briefing` is unvalidated model output when the overlay stamps it, so it is only looked at.
  const briefing = doc.briefing;
  const tldr =
    typeof briefing === "object" && briefing !== null
      ? (briefing as { readonly tldr?: unknown }).tldr
      : undefined;
  if (Array.isArray(tldr)) return TLDR_SCHEMA_VERSION;
  const provenance = doc.provenance;
  if (
    provenance?.flowsUnavailable !== undefined ||
    provenance?.walkthroughUnavailable !== undefined
  )
    return MAP_SECTIONS_SCHEMA_VERSION;
  return provenance?.graphUnavailable?.reason === "no-logic"
    ? NO_LOGIC_SCHEMA_VERSION
    : BASE_SCHEMA_VERSION;
};

const [currentMajor = "1", currentMinor = "0"] = SCHEMA_VERSION.split(".");

/**
 * Which versions this package reads: the current major, at this minor or an older one (an older
 * minor only lacks optional fields). A newer minor than this package knows is refused: it may
 * carry a field this parser would reject as invented.
 */
const minors = Array.from({ length: Number(currentMinor) + 1 }, (_, minor) => String(minor));
export const SUPPORTED_VERSION_PATTERN = `^${currentMajor}\\.(${minors.join("|")})\\.\\d+$`;

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
  // The same rule for the sections drawn by their own calls (schema 1.3, H4-7): a reason is only
  // ever written next to a drawn map that lacks the section.
  .refine(
    (doc) =>
      doc.provenance.flowsUnavailable === undefined ||
      (doc.graph !== undefined && doc.graph.flows.length === 0),
    {
      message: "flowsUnavailable needs a graph without flows",
      path: ["provenance", "flowsUnavailable"],
    },
  )
  .refine(
    (doc) =>
      doc.provenance.walkthroughUnavailable === undefined ||
      (doc.graph !== undefined && doc.graph.walkthrough === undefined),
    {
      message: "walkthroughUnavailable needs a graph without a walkthrough",
      path: ["provenance", "walkthroughUnavailable"],
    },
  )
  .describe("A Rocky Reviews analysis document: one PR revision, fully analysed.");
export type AnalysisDocument = z.infer<typeof AnalysisDocument>;
export type AnalysisDocumentInput = z.input<typeof AnalysisDocument>;
