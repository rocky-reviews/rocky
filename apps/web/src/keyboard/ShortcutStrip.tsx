/**
 * The shortcut strip at the bottom of the Review panel (P6-5, POC `.shortcut-strip`). `/ ask`
 * joins it with Ask (P9-2). While single-key shortcuts are off it says so. H4-14: a/e/d are
 * listed only while the focused draft is on screen, the only time they act.
 */
import { useReview } from "../drafts/ReviewProvider.js";
import { useDraftOnScreen } from "./draft-on-screen.js";
import { useKeyboard } from "./KeyboardContext.js";

type Item = { keys: readonly string[]; label: string; draft?: true };

const ITEMS: readonly Item[] = [
  { keys: ["j", "k"], label: "previous & next file" },
  { keys: ["u", "i"], label: "previous & next AI draft" },
  { keys: ["a"], label: "accept", draft: true },
  { keys: ["e"], label: "edit", draft: true },
  { keys: ["d"], label: "dismiss", draft: true },
  { keys: ["v"], label: "viewed" },
  { keys: ["/"], label: "ask" },
  { keys: ["?"], label: "all shortcuts" },
];

export const ShortcutStrip = () => {
  const { singleKeys } = useKeyboard();
  const { focused } = useReview();
  const onScreen = useDraftOnScreen();
  const draftKeys = onScreen !== null && onScreen === focused;
  return (
    <p className="shortcut-strip">
      {singleKeys ? (
        ITEMS.filter((item) => draftKeys || item.draft !== true).map((item) => (
          <span key={item.label}>
            {item.keys.map((k, i) => (
              <span key={k}>
                {i > 0 && "/"}
                <kbd>{k}</kbd>
              </span>
            ))}{" "}
            {item.label}
          </span>
        ))
      ) : (
        <span>Single-key shortcuts are off. Turn them on in Keyboard shortcuts.</span>
      )}
    </p>
  );
};
