import { parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewContext } from "../drafts/ReviewProvider.js";
import { reviewWith } from "../drafts/testing.js";
import { DraftOnScreenContext } from "./draft-on-screen.js";
import { KeyboardContext } from "./KeyboardContext.js";
import { ShortcutStrip } from "./ShortcutStrip.js";

/** H4-14: the strip lists a/e/d only while the focused draft is on screen. */

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");

const strip = (focused: string | null, onScreen: string | null, singleKeys = true) =>
  renderToStaticMarkup(
    <KeyboardContext value={{ singleKeys, setSingleKeys: () => {}, openHelp: () => {} }}>
      <DraftOnScreenContext value={{ onScreen, report: () => {} }}>
        <ReviewContext value={reviewWith(parsed.value.findings, {}, [], { focused })}>
          <ShortcutStrip />
        </ReviewContext>
      </DraftOnScreenContext>
    </KeyboardContext>,
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("shortcut strip", () => {
  it("lists a/e/d while the focused draft is on screen", () => {
    expect(strip("F1", "F1")).toBe(
      "j / k previous & next file u / i previous & next AI draft a accept e edit d dismiss v viewed ? all shortcuts",
    );
  });

  it("leaves them out otherwise", () => {
    for (const [focused, onScreen] of [
      [null, null],
      ["F1", null],
      ["F2", "F1"],
    ] as const)
      expect(strip(focused, onScreen)).toBe(
        "j / k previous & next file u / i previous & next AI draft v viewed ? all shortcuts",
      );
  });

  it("says when single-key shortcuts are off", () => {
    expect(strip("F1", "F1", false)).toBe(
      "Single-key shortcuts are off. Turn them on in Keyboard shortcuts.",
    );
  });
});
