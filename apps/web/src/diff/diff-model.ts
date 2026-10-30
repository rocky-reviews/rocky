/**
 * The hunk model behind the diff view (P6-3): a file's patch as rows (hunk headers, numbered
 * lines, git's notes), and the flat list of items the virtualised list renders, with AI flags,
 * the reviewer's own comments and the comment composer as blocks under their line.
 *
 * The patch has already been read by `parseUnifiedDiff` (packages/core), which refuses anything
 * malformed, so this only numbers lines. Every string here is PR content: render it as text.
 */
import type { Finding, Flag } from "@rocky-reviews/schema";
import type { FileAnnotations, HotKind } from "./annotations.js";

export type LineKind = "add" | "del" | "ctx";

export type DiffLine = {
  readonly kind: "line";
  readonly type: LineKind;
  readonly oldNo: number | null;
  readonly newNo: number | null;
  readonly text: string;
};

export type DiffRow =
  | { readonly kind: "hunk"; readonly header: string }
  | DiffLine
  | { readonly kind: "note"; readonly text: string };

/** A comment the reviewer wrote on a new-side line. Pending until Finish review (P6-6). */
export type OwnComment = {
  readonly id: string;
  readonly path: string;
  readonly line: number;
  readonly body: string;
};

export type DiffItem =
  | { readonly key: string; readonly kind: "hunk"; readonly header: string }
  | { readonly key: string; readonly kind: "note"; readonly text: string }
  | {
      readonly key: string;
      readonly kind: "line";
      readonly row: DiffLine;
      readonly hot: HotKind | null;
    }
  | {
      readonly key: string;
      readonly kind: "inline";
      readonly line: number;
      readonly flags: readonly Flag[];
      /** AI drafts whose range ends on this line (P6-4). */
      readonly findings: readonly Finding[];
      readonly comments: readonly OwnComment[];
      readonly composing: boolean;
    };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export const fileRows = (patch: string): DiffRow[] => {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const header = HUNK.exec(raw);
    if (header !== null) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      inHunk = true;
      rows.push({ kind: "hunk", header: raw });
      continue;
    }
    // Lines before the first hunk are git's file header (paths, modes, index).
    if (!inHunk) continue;
    const sign = raw[0] ?? " ";
    const text = raw.slice(1);
    if (sign === "+") rows.push({ kind: "line", type: "add", oldNo: null, newNo: newNo++, text });
    else if (sign === "-")
      rows.push({ kind: "line", type: "del", oldNo: oldNo++, newNo: null, text });
    else if (sign === "\\") rows.push({ kind: "note", text: raw.slice(1).trim() });
    else rows.push({ kind: "line", type: "ctx", oldNo: oldNo++, newNo: newNo++, text });
  }
  return rows;
};

/**
 * Rows plus the blocks under them. Keys are stable when blocks come and go (`l<row>` for lines),
 * so the virtualised list keeps each row's measured height. A draft sits under the last line of
 * its range, as the POC shows it.
 */
export const diffItems = (
  rows: readonly DiffRow[],
  annotations: FileAnnotations,
  comments: readonly OwnComment[],
  composingLine: number | null,
  findings: readonly Finding[] = [],
): DiffItem[] => {
  const draftsByLine = new Map<number, Finding[]>();
  for (const finding of findings) {
    const list = draftsByLine.get(finding.range.end) ?? [];
    list.push(finding);
    draftsByLine.set(finding.range.end, list);
  }
  const byLine = new Map<number, OwnComment[]>();
  for (const comment of comments) {
    const list = byLine.get(comment.line) ?? [];
    list.push(comment);
    byLine.set(comment.line, list);
  }
  const items: DiffItem[] = [];
  rows.forEach((row, i) => {
    if (row.kind === "hunk") {
      items.push({ key: `h${i}`, kind: "hunk", header: row.header });
      return;
    }
    if (row.kind === "note") {
      items.push({ key: `n${i}`, kind: "note", text: row.text });
      return;
    }
    const n = row.newNo;
    items.push({
      key: `l${i}`,
      kind: "line",
      row,
      hot: n === null ? null : (annotations.hot.get(n) ?? null),
    });
    if (n === null) return;
    const flags = annotations.flags.get(n) ?? [];
    const drafts = draftsByLine.get(n) ?? [];
    const mine = byLine.get(n) ?? [];
    const composing = composingLine === n;
    if (flags.length > 0 || drafts.length > 0 || mine.length > 0 || composing)
      items.push({
        key: `i${n}`,
        kind: "inline",
        line: n,
        flags,
        findings: drafts,
        comments: mine,
        composing,
      });
  });
  return items;
};
