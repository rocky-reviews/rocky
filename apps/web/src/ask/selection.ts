/**
 * The code a reviewer selected in the diff, for `/` (P9-2, POC: "Select code in the diff and
 * press / to ask about it"). Read when the key is pressed, before focus moves: the file's path
 * from the diff it sits in (`.diff[data-path]`), its new-side lines from the rows the selection
 * touches, and the selected text. A selection outside one file's diff, or one that touches no
 * new-side line (only deleted lines), is not sent: Ask opens without it.
 */
import { MAX_SELECTION_CHARS, type AskSelection } from "./ask-data.js";

/** The selection from its parts, or null when they do not make one. */
export const selectionFrom = (
  path: string | null,
  lines: readonly number[],
  text: string,
): AskSelection | null => {
  const trimmed = text.trim();
  const numbers = lines.filter((n) => Number.isSafeInteger(n) && n >= 1);
  if (path === null || path === "" || trimmed === "" || numbers.length === 0) return null;
  return {
    path,
    startLine: Math.min(...numbers),
    endLine: Math.max(...numbers),
    text: trimmed.slice(0, MAX_SELECTION_CHARS),
  };
};

const elementOf = (node: Node | null): Element | null =>
  node === null ? null : node instanceof Element ? node : node.parentElement;

/** The document's current selection, if it is code in one file's diff. */
export const diffSelection = (
  selection: Selection | null = typeof window === "undefined" ? null : window.getSelection(),
): AskSelection | null => {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const diff = elementOf(range.startContainer)?.closest(".diff[data-path]") ?? null;
  if (diff === null || diff !== elementOf(range.endContainer)?.closest(".diff[data-path]")) {
    return null;
  }
  const lines = [...diff.querySelectorAll<HTMLElement>(".ln")]
    .filter((row) => range.intersectsNode(row))
    .map((row) => Number(row.querySelector<HTMLElement>("button[data-line]")?.dataset["line"]));
  return selectionFrom(diff.getAttribute("data-path"), lines, selection.toString());
};
