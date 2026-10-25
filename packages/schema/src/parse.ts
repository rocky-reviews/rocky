/**
 * Shape, version and integrity in one pass. A document that comes back `ok` is safe to store,
 * render and show; nothing downstream re-checks it. The function never throws: a model (or
 * an attacker steering one) must not be able to crash the pipeline with a document.
 *
 * Input contract: `parseAnalysisDocument` takes JSON-parsed data (plain objects, arrays and
 * primitives, as `JSON.parse` returns). An object reached twice (a cycle or a shared subtree)
 * is reported as TOO_DEEP in linear time. Untrusted text must go through
 * `parseAnalysisDocumentJson`: it is the only entry point with the byte cap, and JSON.parse's
 * duplicate-key rule (last wins) applies there, which is fine because only the returned value
 * is ever stored.
 *
 * Shape-issue mapping adapted from PR Lens (https://github.com/coldteadotai/pr-lens), MIT
 * License, Copyright (c) 2026 Coldtea AI. See NOTICE.
 */
import type { z } from "zod";
import { AnalysisDocument, isSupportedVersion, SCHEMA_VERSION } from "./document.js";
import { formatIssues, formatPath, type Parsed, type SchemaIssue } from "./errors.js";
import { byteLength } from "./graph.js";
import { integrityIssues, type IntegrityOptions } from "./integrity.js";
import { MAX_DOCUMENT_BYTES, MAX_INPUT_DEPTH } from "./limits.js";

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

/** Never echoes the input or the error text: both may carry PR content. */
const internal = (error: unknown): SchemaIssue => ({
  code: "INTERNAL_ERROR",
  path: "",
  message: `parser failed: ${error instanceof Error ? error.name : "unknown error"}`,
});

/**
 * Validating a recursive structure recurses, so a document nested deeply enough (or one with
 * a cycle in the view tree) exhausts the stack while Zod is still walking it. That is reported
 * as what it is rather than thrown.
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
        issues: [
          {
            code: "TOO_DEEP",
            path: "",
            message: "document nests too deeply to read, or contains a cycle",
          },
        ],
      };
    return { read: false, issues: [internal(error)] };
  }
};

/**
 * A cheap, iterative look at the raw input before Zod walks it: a cycle or excessive nesting
 * would otherwise exhaust the stack somewhere in the middle of validation, and an own
 * `__proto__` key inside a payload sample would be dropped silently by record parsing.
 * Returns the first problem with its JSON path, or undefined.
 */
const inspectRawInput = (input: unknown): SchemaIssue | undefined => {
  // Every object may be reached once. A second visit is a cycle or a shared subtree; either
  // way it is not JSON-parsed data, and shared subtrees expand exponentially downstream.
  const visited = new WeakSet<object>();
  const stack: { value: unknown; path: string; depth: number }[] = [
    { value: input, path: "", depth: 0 },
  ];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    const { value, path, depth } = next;
    if (typeof value !== "object" || value === null) continue;
    if (depth > MAX_INPUT_DEPTH)
      return { code: "TOO_DEEP", path, message: `nests deeper than ${MAX_INPUT_DEPTH} levels` };
    if (visited.has(value))
      return {
        code: "TOO_DEEP",
        path,
        message: "the document contains a shared or cyclic reference",
      };
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((child, index) =>
        stack.push({ value: child, path: `${path}[${index}]`, depth: depth + 1 }),
      );
      continue;
    }
    for (const key of Object.keys(value)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (key === "__proto__")
        return {
          code: "INVALID_SHAPE",
          path: childPath,
          message: "key '__proto__' is not allowed",
        };
      stack.push({
        value: (value as Record<string, unknown>)[key],
        path: childPath,
        depth: depth + 1,
      });
    }
  }
  return undefined;
};

export type ParseOptions = IntegrityOptions;

/**
 * Parse JSON-parsed data into a validated analysis document, or explain precisely why not.
 *
 * The returned value has defaults filled in, so it may differ from the input; store the
 * returned value, not the input.
 */
export const parseAnalysisDocument = (
  input: unknown,
  options: ParseOptions = {},
): Parsed<AnalysisDocument> => {
  try {
    const raw = inspectRawInput(input);
    if (raw !== undefined) return fail([raw]);

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
    if (error instanceof RangeError)
      return fail([
        { code: "TOO_DEEP", path: "", message: "document is too large or deep to check" },
      ]);
    return fail([internal(error)]);
  }
};

/**
 * The entry point for untrusted text (a model response, a stored blob): refuses anything over
 * MAX_DOCUMENT_BYTES before `JSON.parse` touches it, reports non-JSON as INVALID_JSON, then
 * validates like `parseAnalysisDocument`. The size is measured in UTF-8 bytes, which is how
 * the document is stored and transferred.
 */
export const parseAnalysisDocumentJson = (
  text: string,
  options: ParseOptions = {},
): Parsed<AnalysisDocument> => {
  if (typeof text !== "string")
    return fail([{ code: "INVALID_JSON", path: "", message: "input must be a string" }]);
  // Each UTF-16 unit is at most 3 UTF-8 bytes; the cheap bound avoids counting a huge string.
  if (text.length > MAX_DOCUMENT_BYTES || byteLength(text) > MAX_DOCUMENT_BYTES)
    return fail([
      {
        code: "LIMIT_EXCEEDED",
        path: "",
        message: `document is larger than ${MAX_DOCUMENT_BYTES} bytes`,
      },
    ]);
  let data: unknown;
  try {
    // A leading BOM is not JSON, but some producers emit one; it carries no content.
    data = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
  } catch {
    return fail([{ code: "INVALID_JSON", path: "", message: "input is not valid JSON" }]);
  }
  return parseAnalysisDocument(data, options);
};
