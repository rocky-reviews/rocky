/**
 * The shortcut strip at the bottom of the Review panel (P6-5, POC `.shortcut-strip`). `/ ask`
 * joins it with Ask (P9-2). While single-key shortcuts are off it says so.
 */
import { useKeyboard } from "./KeyboardContext.js";

const ITEMS: readonly { keys: readonly string[]; label: string }[] = [
  { keys: ["k", "j"], label: "next/prev file" },
  { keys: ["n", "p"], label: "drafts" },
  { keys: ["a"], label: "accept" },
  { keys: ["e"], label: "edit" },
  { keys: ["d"], label: "dismiss" },
  { keys: ["v"], label: "viewed" },
  { keys: ["?"], label: "all shortcuts" },
];

export const ShortcutStrip = () => {
  const { singleKeys } = useKeyboard();
  return (
    <p className="shortcut-strip">
      {singleKeys ? (
        ITEMS.map((item) => (
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
