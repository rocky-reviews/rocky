import type { Page } from "@playwright/test";
import { openFile } from "./diff-support.js";
import { FIXTURE_NOW } from "./support.js";

/**
 * P9-2: the PR page with the fixture Ask source in one of its scenarios
 * (`src/ask/ask-fixture-source.ts`: ready, not-indexed, indexing, off, index-error, no-answer,
 * error, rate-limited, org-rate-limited, slow), and helpers to reach the Ask tab at any width.
 */

export const openAsk = async (page: Page, scenario = "ready"): Promise<void> => {
  await page.clock.setFixedTime(FIXTURE_NOW);
  await page.goto(`/?fixture=pr-847&ask=${scenario}`);
  await page.locator("header.topbar").waitFor();
};

const narrow = (page: Page) => (page.viewportSize()?.width ?? 1440) <= 1180;

/** Shows the Ask tab: in place from 1181 px, in the Review panel's drawer below. */
export const showAskTab = async (page: Page): Promise<void> => {
  if (narrow(page)) await page.getByRole("button", { name: "Review panel", exact: true }).click();
  await page.getByRole("tab", { name: "Ask" }).click();
};

export const questionBox = (page: Page) => page.getByRole("textbox", { name: "Your question" });

/** Asks `question` with Enter once the box takes questions. */
export const ask = async (page: Page, question: string): Promise<void> => {
  const box = questionBox(page);
  await box.fill(question);
  await box.press("Enter");
};

/**
 * Opens `path` and selects the code of its first `rows` new-side rows (as a reviewer would by
 * dragging), returning the line numbers selected.
 */
export const selectDiffRows = async (
  page: Page,
  path: string,
  rows = 3,
): Promise<{ start: number; end: number }> => {
  await openFile(page, path);
  return page.evaluate(
    ({ path, rows }) => {
      const diff = document.querySelector(`.diff[data-path="${CSS.escape(path)}"]`);
      if (diff === null) throw new Error("no diff");
      const lines = [...diff.querySelectorAll<HTMLElement>(".ln")].filter(
        (row) => row.querySelector("button[data-line]") !== null,
      );
      const first = lines[0];
      const last = lines[rows - 1];
      if (first === undefined || last === undefined) throw new Error("too few rows");
      const range = document.createRange();
      range.setStartBefore(first);
      range.setEndAfter(last);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const n = (row: HTMLElement) =>
        Number(row.querySelector<HTMLElement>("button[data-line]")?.dataset["line"]);
      return { start: n(first), end: n(last) };
    },
    { path, rows },
  );
};
