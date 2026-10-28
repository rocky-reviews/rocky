import { describe, expect, it } from "vitest";
import themeInit from "../public/theme-init.js?raw";
import { readSavedMode, resolveMode, saveMode, STORAGE_KEY } from "./theme.js";

const memoryStorage = (initial: Record<string, string> = {}): Storage => {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
};

const throwing = (): Storage => {
  throw new DOMException("blocked", "SecurityError");
};

describe("resolveMode", () => {
  it("prefers a saved choice over the system", () => {
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });

  it("follows the system without a valid saved choice", () => {
    expect(resolveMode(null, true)).toBe("dark");
    expect(resolveMode(null, false)).toBe("light");
    expect(resolveMode("purple", true)).toBe("dark");
  });
});

describe("theme storage", () => {
  it("round-trips the choice", () => {
    const storage = memoryStorage();
    expect(saveMode(() => storage, "dark")).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBe("dark");
    expect(readSavedMode(() => storage)).toBe("dark");
  });

  it("ignores values it did not write", () => {
    expect(readSavedMode(() => memoryStorage({ [STORAGE_KEY]: "<script>" }))).toBeNull();
  });

  it("survives storage that throws on access, read or write", () => {
    expect(readSavedMode(throwing)).toBeNull();
    expect(saveMode(throwing, "dark")).toBe(false);
    const failing = memoryStorage();
    failing.getItem = () => {
      throw new Error("quota");
    };
    failing.setItem = () => {
      throw new Error("quota");
    };
    expect(readSavedMode(() => failing)).toBeNull();
    expect(saveMode(() => failing, "light")).toBe(false);
  });
});

/** Runs public/theme-init.js against a fake window and returns the mode it set. */
const runInit = (options: {
  saved?: string | null;
  systemDark?: boolean;
  storageThrows?: boolean;
  noMatchMedia?: boolean;
}): { mode: string | undefined; colorScheme: string } => {
  const root = { dataset: {} as Record<string, string>, style: { colorScheme: "" } };
  const window = {
    get localStorage(): Storage {
      if (options.storageThrows) throw new DOMException("blocked", "SecurityError");
      return memoryStorage(options.saved ? { [STORAGE_KEY]: options.saved } : {});
    },
    matchMedia: options.noMatchMedia
      ? undefined
      : (query: string) => ({ matches: query.includes("dark") && options.systemDark === true }),
  };
  new Function("window", "document", themeInit)(window, { documentElement: root });
  return { mode: root.dataset.mode, colorScheme: root.style.colorScheme };
};

describe("theme-init.js (before first paint)", () => {
  it("applies the saved choice", () => {
    expect(runInit({ saved: "dark", systemDark: false })).toEqual({
      mode: "dark",
      colorScheme: "dark",
    });
    expect(runInit({ saved: "light", systemDark: true }).mode).toBe("light");
  });

  it("defaults to the system preference", () => {
    expect(runInit({ systemDark: true }).mode).toBe("dark");
    expect(runInit({ systemDark: false }).mode).toBe("light");
    expect(runInit({ saved: "nonsense", systemDark: true }).mode).toBe("dark");
  });

  it("falls back to the system when storage throws, and to light without matchMedia", () => {
    expect(runInit({ storageThrows: true, systemDark: true }).mode).toBe("dark");
    expect(runInit({ storageThrows: true, noMatchMedia: true }).mode).toBe("light");
  });

  it("uses the storage key the app writes", () => {
    expect(themeInit).toContain(`"${STORAGE_KEY}"`);
  });
});
