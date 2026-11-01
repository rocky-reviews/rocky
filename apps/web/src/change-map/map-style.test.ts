import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAP_STYLE,
  MAP_STYLE_KEY,
  MAP_STYLES,
  mapStyleLabel,
  readMapStyle,
  saveMapStyle,
} from "./map-style.js";

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

describe("the change map style setting", () => {
  it("offers three styles, Live traffic first and by default", () => {
    expect(MAP_STYLES.map((option) => option.label)).toEqual([
      "Live traffic",
      "Guided walkthrough",
      "Flow playback",
    ]);
    expect(DEFAULT_MAP_STYLE).toBe("live");
    expect(readMapStyle(() => memoryStorage())).toBe("live");
    expect(mapStyleLabel("flows")).toBe("Flow playback");
  });

  it("round-trips each choice", () => {
    const storage = memoryStorage();
    for (const { value } of MAP_STYLES) {
      expect(saveMapStyle(() => storage, value)).toBe(true);
      expect(storage.getItem(MAP_STYLE_KEY)).toBe(value);
      expect(readMapStyle(() => storage)).toBe(value);
    }
  });

  it("ignores values it did not write", () => {
    for (const value of ["<script>", "Live traffic", "LIVE", "", "__proto__"])
      expect(readMapStyle(() => memoryStorage({ [MAP_STYLE_KEY]: value }))).toBe("live");
  });

  it("survives storage that throws on access, read or write", () => {
    expect(readMapStyle(throwing)).toBe("live");
    expect(saveMapStyle(throwing, "flows")).toBe(false);
    const failing = memoryStorage();
    failing.getItem = () => {
      throw new Error("quota");
    };
    failing.setItem = () => {
      throw new Error("quota");
    };
    expect(readMapStyle(() => failing)).toBe("live");
    expect(saveMapStyle(() => failing, "walkthrough")).toBe(false);
  });

  it("uses its own key, apart from the theme's", () => {
    expect(MAP_STYLE_KEY).toBe("rocky-map-style");
  });
});
