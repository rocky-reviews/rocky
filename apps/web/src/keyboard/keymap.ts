/**
 * Keyboard shortcuts on the PR page (P6-5, ADR 0030, POC `keydown`): which key does what, when a
 * key counts as a shortcut, and where k/j and n/p move. Pure, so it is tested without a DOM.
 *
 * - Single-character keys (k j n p a e d v / b m ?) fire only with no Ctrl, ⌘ or Alt, never
 *   while typing, and can be turned off (WCAG 2.1.4); the choice is remembered per browser.
 * - ⌘/Ctrl+Enter (finish) has a modifier, so it stays on; it too is ignored while typing, where
 *   text fields give it their own meaning (save the comment).
 */

export type ShortcutAction =
  | "nextFile"
  | "prevFile"
  | "nextDraft"
  | "prevDraft"
  | "accept"
  | "edit"
  | "dismiss"
  | "viewed"
  | "ask"
  | "briefing"
  | "mode"
  | "help"
  | "finish";

const SINGLE_KEYS: Readonly<Record<string, ShortcutAction>> = {
  k: "nextFile",
  j: "prevFile",
  n: "nextDraft",
  p: "prevDraft",
  a: "accept",
  e: "edit",
  d: "dismiss",
  v: "viewed",
  "/": "ask",
  b: "briefing",
  m: "mode",
  "?": "help",
};

/** Holding one of these keys moves on; holding any other key acts once. */
const REPEATABLE: ReadonlySet<ShortcutAction> = new Set([
  "nextFile",
  "prevFile",
  "nextDraft",
  "prevDraft",
]);

export type KeyInput = {
  readonly key: string;
  /** The physical key (`KeyK`), for layouts whose letters are not ASCII. */
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly defaultPrevented: boolean;
};

/**
 * The key as the shortcut table spells it. Letters are matched lower-case without Shift, so
 * Caps Lock does not turn them off; on a layout whose letters are not ASCII (Cyrillic, Greek…)
 * the physical key stands in, so "k" is where k is on a US keyboard. Shift+letter stays itself
 * and matches nothing.
 */
const keyName = (event: KeyInput): string => {
  if (/^[a-z]$/i.test(event.key)) return event.shiftKey ? event.key : event.key.toLowerCase();
  const physical = /^Key([A-Z])$/.exec(event.code);
  if (physical !== null && !event.shiftKey && [...event.key].length === 1)
    return (physical[1] ?? "").toLowerCase();
  return event.key;
};

/** The action for a key press, or null. `singleKeys`: the reviewer's on/off choice. */
export const shortcutFor = (event: KeyInput, singleKeys: boolean): ShortcutAction | null => {
  if (event.defaultPrevented || event.isComposing) return null;
  if (event.key === "Enter")
    return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && !event.repeat
      ? "finish"
      : null;
  if (!singleKeys || event.ctrlKey || event.metaKey || event.altKey) return null;
  const name = keyName(event);
  if (!Object.hasOwn(SINGLE_KEYS, name)) return null;
  const action = SINGLE_KEYS[name] ?? null;
  if (action === null || (event.repeat && !REPEATABLE.has(action))) return null;
  return action;
};

/** Input types that take no typed text: a letter pressed on them is still a shortcut. */
const NOT_TEXT = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "range",
  "color",
  "file",
  "image",
]);

export type FocusTarget = {
  readonly tagName: string;
  readonly type?: string;
  readonly isContentEditable?: boolean;
} | null;

/** True where keys type text: text inputs, textareas, selects and contenteditable. */
export const isTextEntry = (el: FocusTarget): boolean => {
  if (el === null) return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && !NOT_TEXT.has((el.type ?? "text").toLowerCase());
};

/**
 * k/j: the briefing, then the files in review order (the sidebar's order, noise last), clamped
 * at both ends. `null` is the briefing. A file outside the order (not analysed) moves to the
 * first file with k and to the briefing with j.
 */
export const stepFile = (
  order: readonly string[],
  current: string | null,
  dir: 1 | -1,
): string | null => {
  const seq: (string | null)[] = [null, ...order];
  const at = seq.indexOf(current);
  if (at === -1) return dir > 0 ? (order[0] ?? null) : null;
  return seq[Math.max(0, Math.min(seq.length - 1, at + dir))] ?? null;
};

/**
 * n/p: the undecided drafts by severity, or every draft once none is left (POC `cycleFinding`);
 * from the focused one, wrapping; from none (or a decided one), the first or the last.
 */
export const stepDraft = (
  bySeverity: readonly string[],
  undecided: (id: string) => boolean,
  focused: string | null,
  dir: 1 | -1,
): string | undefined => {
  const open = bySeverity.filter(undecided);
  const pool = open.length > 0 ? open : bySeverity;
  if (pool.length === 0) return undefined;
  const at = focused === null ? -1 : pool.indexOf(focused);
  if (at === -1) return dir > 0 ? pool[0] : pool.at(-1);
  return pool[(at + dir + pool.length) % pool.length];
};

/** The help dialog's rows, in the POC's order. `keys` are shown as separate <kbd>s. */
export const HELP_ROWS: readonly { keys: readonly string[]; label: string; single: boolean }[] = [
  { keys: ["k", "j"], label: "Next / previous file (in risk order)", single: true },
  { keys: ["n", "p"], label: "Next / previous AI draft", single: true },
  { keys: ["a"], label: "Accept the focused draft as your comment", single: true },
  { keys: ["e"], label: "Edit the focused draft", single: true },
  { keys: ["d"], label: "Dismiss the focused draft", single: true },
  { keys: ["v"], label: "Toggle viewed on the current file", single: true },
  { keys: ["/"], label: "Ask about the PR (not available yet)", single: true },
  { keys: ["b"], label: "Back to the briefing", single: true },
  { keys: ["m"], label: "Toggle light / dark", single: true },
  { keys: ["?"], label: "This list", single: true },
  { keys: ["finish"], label: "Finish review", single: false },
  { keys: ["Esc"], label: "Close / cancel", single: false },
];

export const isMac = (userAgent: string): boolean => /Mac OS X|iPhone|iPad/.test(userAgent);

/** "⌘↵" on a Mac, "Ctrl+Enter" elsewhere. */
export const finishKeys = (mac: boolean): string => (mac ? "⌘↵" : "Ctrl+Enter");

export const SHORTCUTS_KEY = "rocky-shortcuts";

/** On unless this browser saved "off". Storage can throw; then they stay on. */
export const readSingleKeys = (storage: () => Storage): boolean => {
  try {
    return storage().getItem(SHORTCUTS_KEY) !== "off";
  } catch {
    return true;
  }
};

/** Returns whether the choice was stored. */
export const saveSingleKeys = (storage: () => Storage, on: boolean): boolean => {
  try {
    if (on) storage().removeItem(SHORTCUTS_KEY);
    else storage().setItem(SHORTCUTS_KEY, "off");
    return true;
  } catch {
    return false;
  }
};
