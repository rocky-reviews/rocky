import { describe, expect, it } from "vitest";
import {
  finishKeys,
  type KeyInput,
  isMac,
  isTextEntry,
  readSingleKeys,
  saveSingleKeys,
  SHORTCUTS_KEY,
  shortcutFor,
  stepDraft,
  stepFile,
} from "./keymap.js";

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
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
    const keys = { k: "nextFile", j: "prevFile", n: "nextDraft", p: "prevDraft" } as const;
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

  it("ignores other keys, upper case and inherited names", () => {
    for (const k of ["x", "K", "Enter", "Escape", " ", "toString", "constructor"])
      expect(shortcutFor(key(k), true)).toBeNull();
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
    expect(shortcutFor(key("n", { repeat: true }), true)).toBe("nextDraft");
    for (const k of ["a", "e", "d", "v", "m", "?", "/", "b"])
      expect(shortcutFor(key(k, { repeat: true }), true)).toBeNull();
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
  it("starts at the first (n) or last (p) undecided draft", () => {
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
