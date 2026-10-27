/**
 * pr-1104, "Invoice CSV export" (P4-7). Synthetic: written for Rocky's evals.
 */
import { addedFile, fakeModel } from "./fake-model.js";
import type { SeededPr } from "./types.js";

const EXPORT = "src/billing/exportInvoices.ts";
const CSV = "src/billing/csv.ts";
const ROUTE = "src/api/routes/invoices.ts";

export const PR1104_FILES: Readonly<Record<string, readonly string[]>> = {
  [EXPORT]: [
    'import { db } from "../db";',
    'import { toCsv } from "./csv";',
    "",
    'const COLUMNS = ["number", "customer", "amount_cents", "issued_at"];',
    "",
    "export async function exportInvoices(orgId: string, sort: string, from?: string) {",
    "  const rows = await db.query(",
    '    `select ${COLUMNS.join(", ")} from invoices where issued_at >= $1 order by ${sort}`,',
    '    [from ?? "1970-01-01"],',
    "  );",
    "  return toCsv(COLUMNS, rows);",
    "}",
  ],
  [CSV]: [
    "export function toCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]) {",
    '  const lines = [columns.join(",")];',
    "  for (const row of rows) {",
    '    lines.push(columns.map((c) => String(row[c] ?? "")).join(","));',
    "  }",
    '  return lines.join("\\n");',
    "}",
  ],
  [ROUTE]: [
    'import { Router } from "express";',
    'import { requireSession } from "../middleware/session";',
    'import { exportInvoices } from "../../billing/exportInvoices";',
    "",
    "export const invoices = Router();",
    "",
    'invoices.get("/orgs/:orgId/invoices.csv", requireSession, async (req, res) => {',
    '  const sort = String(req.query.sort ?? "issued_at");',
    "  const csv = await exportInvoices(req.params.orgId, sort, req.query.from as string);",
    '  res.type("text/csv").send(csv);',
    "});",
  ],
};

export const PR1104: SeededPr = {
  id: "pr-1104",
  number: 1104,
  title: "Invoice CSV export",
  base: "1104".padEnd(40, "a"),
  head: "1104".padEnd(40, "b"),
  provenance:
    "Synthetic, written for Rocky's evals (P4-7, 2026-10-27); not taken from any repository. A CSV export of invoices with six planted issues: SQL injection through the sort column, a query not scoped to the org, no membership check, unescaped CSV values, spreadsheet formula injection and an unbounded read. Two pairs share a line, so the keyword rule is what tells them apart.",
  diff: () =>
    `${Object.entries(PR1104_FILES)
      .flatMap(([path, lines]) => addedFile(path, lines))
      .join("\n")}\n`,
  expected: [
    {
      id: "I1",
      path: EXPORT,
      severity: "critical",
      range: { start: 8, end: 8 },
      title: "SQL injection through the sort column",
      keywords: ["sql injection", "injection", "order by", "sort"],
    },
    {
      id: "I2",
      path: EXPORT,
      severity: "critical",
      range: { start: 8, end: 8 },
      title: "The query is not scoped to the org: every org's invoices are exported",
      keywords: ["org_id", "orgid", "tenant", "scoped", "other org", "every org", "any org"],
    },
    {
      id: "I3",
      path: EXPORT,
      severity: "low",
      range: { start: 7, end: 10 },
      title: "Reads every invoice into memory at once",
      keywords: ["memory", "stream", "paginat", "unbounded", "large"],
    },
    {
      id: "I4",
      path: CSV,
      severity: "medium",
      range: { start: 4, end: 4 },
      title: "Values are not quoted, so commas and newlines break rows",
      keywords: ["escap", "quot", "comma", "newline"],
    },
    {
      id: "I5",
      path: CSV,
      severity: "medium",
      range: { start: 4, end: 4 },
      title: "Spreadsheet formula injection through cell values",
      keywords: ["formula", "spreadsheet", "excel", "csv injection"],
    },
    {
      id: "I6",
      path: ROUTE,
      severity: "high",
      range: { start: 7, end: 9 },
      title: "No check that the caller belongs to the org",
      keywords: ["member", "belong", "authoriz", "permission", "access check"],
    },
  ],
  tolerated: [],
  fake: fakeModel({
    triage: {
      [EXPORT]: { score: 90, level: "critical", reason: "Builds SQL over billing data." },
      [CSV]: { score: 55, level: "important", reason: "Serialises billing data." },
      [ROUTE]: { score: 70, level: "important", reason: "New endpoint over billing data." },
    },
    findings: {
      [EXPORT]: [
        { severity: "critical", lines: 8, title: "SQL injection through the sort parameter" },
        { severity: "critical", lines: 8, title: "Export is not scoped to the org (tenant leak)" },
      ],
      [CSV]: [{ severity: "medium", lines: 4, title: "Values are not quoted or escaped" }],
      [ROUTE]: [
        { severity: "high", lines: 7, title: "No check that the caller belongs to the org" },
        { severity: "critical", lines: 10, title: "CSV sent without Content-Disposition: XSS" },
      ],
    },
    summary: "Adds a CSV export of an org's invoices.",
    verdict: { level: "critical", reason: "User input reaches SQL and the export crosses orgs." },
  }),
};
