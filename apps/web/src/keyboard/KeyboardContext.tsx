/**
 * What the page's controls need to know about the shortcuts (P6-5, ADR 0030): whether
 * single-key shortcuts are on (their hints and `aria-keyshortcuts` go with them) and how to open
 * the shortcuts dialog. The shell owns the state; without it, shortcuts read as on.
 */
import { createContext, useContext } from "react";

export type KeyboardContextValue = {
  readonly singleKeys: boolean;
  readonly setSingleKeys: (on: boolean) => void;
  readonly openHelp: () => void;
};

export const KeyboardContext = createContext<KeyboardContextValue>({
  singleKeys: true,
  setSingleKeys: () => {},
  openHelp: () => {},
});

export const useKeyboard = (): KeyboardContextValue => useContext(KeyboardContext);

/** The `aria-keyshortcuts` value for a single-key shortcut: none while they are off. */
export const useKeyShortcut = (key: string): string | undefined =>
  useKeyboard().singleKeys ? key : undefined;

/**
 * A key hint inside the button the key triggers (POC `<kbd>`). Hidden from screen readers, so
 * the button's name stays "Accept"; `aria-keyshortcuts` on the button says it instead. `on`: the
 * button is a primary one (POC `.kbd-on`).
 */
export const Kbd = ({ k, on = false }: { k: string; on?: boolean }) =>
  useKeyboard().singleKeys ? (
    <kbd className={on ? "kbd-on" : undefined} aria-hidden="true">
      {k}
    </kbd>
  ) : null;
