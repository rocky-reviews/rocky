import { describe, expect, it } from "vitest";
import {
  finishKeys,
  HELP_ROWS,
  type KeyInput,
  isMac,
  isTextEntry,
  readSingleKeys,
  reasonIndexFor,
  SCROLL_STEP,
  scrollStepFor,
  saveSingleKeys,
  SHORTCUTS_KEY,
  shortcutFor,
  stepDraft,
  stepFile,
} from "./keymap.js";

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : "",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  defaultPrevented: false,
  ...extra,
});

describe("shortcutFor", () => {
  it("maps the POC's keys", () => {
    const keys = { k: "nextFile", j: "prevFile", i: "nextDraft", u: "prevDraft" } as const;
    for (const [k, action] of Object.entries(keys)) expect(shortcutFor(key(k), true)).toBe(action);
    expect(shortcutFor(key("a"), true)).toBe("accept");
    expect(shortcutFor(key("e"), true)).toBe("edit");
    expect(shortcutFor(key("d"), true)).toBe("dismiss");
    expect(shortcutFor(key("v"), true)).toBe("viewed");
    expect(shortcutFor(key("/"), true)).toBe("ask");
    expect(shortcutFor(key("b"), true)).toBe("briefing");
    expect(shortcutFor(key("m"), true)).toBe("mode");
    expect(shortcutFor(key("?", { shiftKey: true }), true)).toBe("help");
  });

  it("H4-14: i/u walk the drafts; n and p do nothing now", () => {
    expect(shortcutFor(key("i"), true)).toBe("nextDraft");
    expect(shortcutFor(key("u"), true)).toBe("prevDraft");
    expect(shortcutFor(key("n"), true)).toBeNull();
    expect(shortcutFor(key("p"), true)).toBeNull();
    expect(shortcutFor(key("i"), false)).toBeNull();
    expect(shortcutFor(key("u", { altKey: true }), true)).toBeNull();
  });

  it("H4-14: the help reads j/k and u/i, previous before next", () => {
    expect(HELP_ROWS[0]).toEqual({
      keys: ["j", "k"],
      label: "Previous & next file (in risk order)",
      single: true,
    });
    expect(HELP_ROWS[1]).toEqual({
      keys: ["u", "i"],
      label: "Previous & next AI draft (this file's first)",
      single: true,
    });
    expect(HELP_ROWS.flatMap((r) => r.keys)).not.toContain("n");
    expect(HELP_ROWS.find((r) => r.keys.includes("1"))).toEqual({
      keys: ["1", "2", "3", "4"],
      label: "Dismiss reason: not a real issue, intentional, not worth it, handled elsewhere",
      single: true,
    });
  });

  it("H4-12: t opens the change tree, and is listed in the help", () => {
    expect(shortcutFor(key("t"), true)).toBe("tree");
    expect(shortcutFor(key("T"), true)).toBe("tree");
    expect(shortcutFor(key("T", { shiftKey: true }), true)).toBeNull();
    expect(shortcutFor(key("t"), false)).toBeNull();
    expect(shortcutFor(key("t", { metaKey: true }), true)).toBeNull();
    expect(shortcutFor(key("t", { repeat: true }), true)).toBeNull();
    expect(HELP_ROWS.find((r) => r.keys.includes("t"))).toEqual({
      keys: ["t"],
      label: "Change tree: what changed where",
      single: true,
    });
    // Every single key in the help maps to exactly one action.
    const singles = HELP_ROWS.filter((r) => r.single).flatMap((r) => r.keys);
    expect(new Set(singles).size).toBe(singles.length);
  });

  it("ignores other keys, Shift+letter and inherited names", () => {
    for (const k of ["x", "Enter", "Escape", " ", "toString", "constructor"])
      expect(shortcutFor(key(k), true)).toBeNull();
    expect(shortcutFor(key("K", { shiftKey: true }), true)).toBeNull();
  });

  it("works with Caps Lock on (an upper-case letter without Shift)", () => {
    expect(shortcutFor(key("K"), true)).toBe("nextFile");
    expect(shortcutFor(key("A"), true)).toBe("accept");
  });

  it("uses the physical key on layouts whose letters are not ASCII", () => {
    // Russian: the key where k is types "л", where i is "ш"; Greek: where m is "μ".
    expect(shortcutFor(key("л", { code: "KeyK" }), true)).toBe("nextFile");
    expect(shortcutFor(key("ш", { code: "KeyI" }), true)).toBe("nextDraft");
    expect(shortcutFor(key("μ", { code: "KeyM" }), true)).toBe("mode");
    // Caps Lock there too; but not with Shift, and not for a key that is not a letter key.
    expect(shortcutFor(key("Л", { code: "KeyK" }), true)).toBe("nextFile");
    expect(shortcutFor(key("Л", { code: "KeyK", shiftKey: true }), true)).toBeNull();
    expect(shortcutFor(key("ж", { code: "Semicolon" }), true)).toBeNull();
    // An ASCII letter wins over its physical key (AZERTY's "a" is where q is).
    expect(shortcutFor(key("a", { code: "KeyQ" }), true)).toBe("accept");
  });

  it("ignores single keys with Ctrl, ⌘ or Alt", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const)
      expect(shortcutFor(key("k", { [mod]: true }), true)).toBeNull();
  });

  it("finishes with ⌘ or Ctrl + Enter only", () => {
    expect(shortcutFor(key("Enter", { metaKey: true }), true)).toBe("finish");
    expect(shortcutFor(key("Enter", { ctrlKey: true }), false)).toBe("finish");
    expect(shortcutFor(key("Enter", { ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(shortcutFor(key("Enter", { metaKey: true, altKey: true }), true)).toBeNull();
    expect(shortcutFor(key("Enter", { metaKey: true, repeat: true }), true)).toBeNull();
  });

  it("turned off, single keys do nothing (WCAG 2.1.4)", () => {
    for (const k of ["k", "a", "?", "/", "m"]) expect(shortcutFor(key(k), false)).toBeNull();
  });

  it("ignores handled events and IME composition", () => {
    expect(shortcutFor(key("k", { defaultPrevented: true }), true)).toBeNull();
    expect(shortcutFor(key("k", { isComposing: true }), true)).toBeNull();
  });

  it("repeats only movement while a key is held", () => {
    expect(shortcutFor(key("k", { repeat: true }), true)).toBe("nextFile");
    expect(shortcutFor(key("i", { repeat: true }), true)).toBe("nextDraft");
    expect(shortcutFor(key("u", { repeat: true }), true)).toBe("prevDraft");
    for (const k of ["a", "e", "d", "v", "m", "?", "/", "b"])
      expect(shortcutFor(key(k, { repeat: true }), true)).toBeNull();
  });
});

describe("reasonIndexFor (H4-14)", () => {
  it("maps 1–4 to the four reasons, from the digit row or the keypad", () => {
    expect(["1", "2", "3", "4"].map((k) => reasonIndexFor(key(k), true))).toEqual([0, 1, 2, 3]);
    expect(reasonIndexFor(key("3", { code: "Numpad3" }), true)).toBe(2);
    for (const k of ["0", "5", "9", "a", "Enter"]) expect(reasonIndexFor(key(k), true)).toBeNull();
  });

  it("uses the physical key where the digit row needs Shift (AZERTY)", () => {
    expect(reasonIndexFor(key("&", { code: "Digit1" }), true)).toBe(0);
    expect(reasonIndexFor(key("é", { code: "Digit2" }), true)).toBe(1);
    // US Shift+1 is "!": not a reason.
    expect(reasonIndexFor(key("!", { code: "Digit1", shiftKey: true }), true)).toBeNull();
  });

  it("follows the shortcut rules: off, modifiers, held keys, handled events", () => {
    expect(reasonIndexFor(key("1"), false)).toBeNull();
    for (const mod of ["ctrlKey", "metaKey", "altKey"] as const)
      expect(reasonIndexFor(key("1", { [mod]: true }), true)).toBeNull();
    expect(reasonIndexFor(key("1", { repeat: true }), true)).toBeNull();
    expect(reasonIndexFor(key("1", { defaultPrevented: true }), true)).toBeNull();
    expect(reasonIndexFor(key("1", { isComposing: true }), true)).toBeNull();
  });
});

describe("scrollStepFor (H4-14)", () => {
  it("scrolls by a line-ish step with focus on the page", () => {
    expect(scrollStepFor(key("ArrowDown"), true)).toBe(SCROLL_STEP);
    expect(scrollStepFor(key("ArrowUp"), true)).toBe(-SCROLL_STEP);
    expect(scrollStepFor(key("ArrowDown", { repeat: true }), true)).toBe(SCROLL_STEP);
  });

  it("leaves arrows alone anywhere else, with modifiers, other keys, or handled events", () => {
    expect(scrollStepFor(key("ArrowDown"), false)).toBeNull();
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey"] as const)
      expect(scrollStepFor(key("ArrowDown", { [mod]: true }), true)).toBeNull();
    for (const k of ["ArrowLeft", "PageDown", "j"]) expect(scrollStepFor(key(k), true)).toBeNull();
    expect(scrollStepFor(key("ArrowDown", { defaultPrevented: true }), true)).toBeNull();
  });
});

describe("isTextEntry", () => {
  it("is true where keys type text", () => {
    expect(isTextEntry({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntry({ tagName: "SELECT" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT" })).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("is false on buttons, checkboxes, switches and plain elements", () => {
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "radio" })).toBe(false);
    expect(isTextEntry({ tagName: "ARTICLE", isContentEditable: false })).toBe(false);
  });
});

describe("stepFile", () => {
  const order = ["a.ts", "b.ts", "c.ts"];
  it("goes from the briefing to the first file and back", () => {
    expect(stepFile(order, null, 1)).toBe("a.ts");
    expect(stepFile(order, "a.ts", -1)).toBeNull();
  });
  it("walks the order and stops at either end", () => {
    expect(stepFile(order, "a.ts", 1)).toBe("b.ts");
    expect(stepFile(order, "c.ts", -1)).toBe("b.ts");
    expect(stepFile(order, "c.ts", 1)).toBe("c.ts");
    expect(stepFile(order, null, -1)).toBeNull();
  });
  it("from a file outside the order: k to the first file, j to the briefing", () => {
    expect(stepFile(order, "x.ts", 1)).toBe("a.ts");
    expect(stepFile(order, "x.ts", -1)).toBeNull();
    expect(stepFile([], null, 1)).toBeNull();
  });
});

describe("stepDraft", () => {
  const ids = ["F1", "F2", "F3", "F4"];
  const open =
    (...undecided: string[]) =>
    (id: string) =>
      undecided.includes(id);
  it("starts at the first (i) or last (u) undecided draft", () => {
    expect(stepDraft(ids, open("F2", "F3"), null, 1)).toBe("F2");
    expect(stepDraft(ids, open("F2", "F3"), null, -1)).toBe("F3");
  });
  it("moves among undecided drafts, wrapping", () => {
    expect(stepDraft(ids, open("F1", "F2", "F4"), "F2", 1)).toBe("F4");
    expect(stepDraft(ids, open("F1", "F2", "F4"), "F4", 1)).toBe("F1");
    expect(stepDraft(ids, open("F1", "F2", "F4"), "F1", -1)).toBe("F4");
  });
  it("from a just-decided draft, goes to the first undecided one", () => {
    expect(stepDraft(ids, open("F3", "F4"), "F2", 1)).toBe("F3");
  });
  it("walks every draft once all are decided", () => {
    expect(stepDraft(ids, open(), "F2", 1)).toBe("F3");
    expect(stepDraft(ids, open(), null, -1)).toBe("F4");
    expect(stepDraft([], open(), null, 1)).toBeUndefined();
  });
});

describe("single-key preference", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    } as unknown as Storage;
  };
  const throwing = (): Storage => {
    throw new DOMException("blocked", "SecurityError");
  };

  it("is on by default and round-trips off and on", () => {
    const s = memory();
    expect(readSingleKeys(() => s)).toBe(true);
    expect(saveSingleKeys(() => s, false)).toBe(true);
    expect(s.getItem(SHORTCUTS_KEY)).toBe("off");
    expect(readSingleKeys(() => s)).toBe(false);
    saveSingleKeys(() => s, true);
    expect(s.getItem(SHORTCUTS_KEY)).toBeNull();
    expect(readSingleKeys(() => s)).toBe(true);
  });

  it("tolerates storage that throws", () => {
    expect(readSingleKeys(throwing)).toBe(true);
    expect(saveSingleKeys(throwing, false)).toBe(false);
  });
});

describe("platform labels", () => {
  it("shows ⌘↵ on a Mac and Ctrl+Enter elsewhere", () => {
    expect(isMac("Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0)")).toBe(true);
    expect(isMac("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe(false);
    expect(finishKeys(true)).toBe("⌘↵");
    expect(finishKeys(false)).toBe("Ctrl+Enter");
  });
});
