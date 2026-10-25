/**
 * Shape, version and integrity in one pass. A document that comes back `ok` is safe to store,
 * render and show; nothing downstream re-checks it. The function never throws: a model (or
 * an attacker steering one) must not be able to crash the pipeline with a document.
 */
import type { z } from "zod";
import { AnalysisDocument, isSupportedVersion, SCHEMA_VERSION } from "./document.js";
import { formatIssues, formatPath, type Parsed, type SchemaIssue } from "./errors.js";
import { integrityIssues, type IntegrityOptions } from "./integrity.js";

const shapeIssues = (error: z.ZodError): SchemaIssue[] =>
  error.issues.map((issue) => ({
    code: "INVALID_SHAPE" as const,
    path: formatPath(issue.path),
    message: issue.message,
  }));

const fail = (issues: readonly SchemaIssue[]): Parsed<never> => {
  const first = issues[0];
  return {
    ok: false,
    error: {
      code: first?.code ?? "INVALID_SHAPE",
      message: `invalid analysis document:\n${formatIssues(issues)}`,
      issues,
    },
  };
};

/**
 * Validating a recursive structure recurses, so a document nested deeply enough exhausts the
 * stack while Zod is still walking it. That is reported as what it is rather than thrown.
 */
const attemptParse = (
  input: unknown,
): { read: true; value: AnalysisDocument } | { read: false; issues: SchemaIssue[] } => {
  try {
    const result = AnalysisDocument.safeParse(input);
    return result.success
      ? { read: true, value: result.data }
      : { read: false, issues: shapeIssues(result.error) };
  } catch (error) {
    if (error instanceof RangeError)
      return {
        read: false,
        issues: [{ code: "TOO_DEEP", path: "", message: "document nests too deeply to read" }],
      };
    return {
      read: false,
      issues: [
        {
          code: "INTERNAL_ERROR",
          path: "",
          message: `parser failed: ${error instanceof Error ? error.name : "unknown error"}`,
        },
      ],
    };
  }
};

export type ParseOptions = IntegrityOptions;

/**
 * Parse anything into a validated analysis document, or explain precisely why not.
 *
 * The returned value has defaults filled in, so it may differ from the input; store the
 * returned value, not the input.
 */
export const parseAnalysisDocument = (
  input: unknown,
  options: ParseOptions = {},
): Parsed<AnalysisDocument> => {
  try {
    const shape = attemptParse(input);
    if (!shape.read) return fail(shape.issues);

    const doc = shape.value;
    const issues: SchemaIssue[] = [];
    if (!isSupportedVersion(doc.schemaVersion))
      issues.push({
        code: "UNSUPPORTED_SCHEMA_VERSION",
        path: "schemaVersion",
        message: `document targets schema version ${doc.schemaVersion}; this package implements ${SCHEMA_VERSION}`,
      });
    issues.push(...integrityIssues(doc, options));
    if (issues.length > 0) return fail(issues);

    return { ok: true, value: doc };
  } catch (error) {
    return fail([
      {
        code: "INTERNAL_ERROR",
        path: "",
        message: `parser failed: ${error instanceof Error ? error.name : "unknown error"}`,
      },
    ]);
  }
};
