import { describe, expect, it } from "vitest";
import {
  LOWER_RISK_KEY,
  lowerRiskShownByDefault,
  readLowerRisk,
  saveLowerRisk,
} from "./lower-risk.js";
import type { SidebarGroup } from "./triage-model.js";

const memory = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  };
};

const throwing = (): Storage => {
  throw new Error("blocked");
};

const group = (level: SidebarGroup["level"]): SidebarGroup => ({
  level,
  files: [{ path: `${level}.ts`, level, score: 1, findings: [] }],
});

describe("the lower-risk choice (H4-9)", () => {
  it("round-trips through storage under its own key", () => {
    const store = memory();
    expect(readLowerRisk(() => store)).toBeNull();
    expect(saveLowerRisk(() => store, true)).toBe(true);
    expect(store.getItem(LOWER_RISK_KEY)).toBe("shown");
    expect(readLowerRisk(() => store)).toBe(true);
    saveLowerRisk(() => store, false);
    expect(readLowerRisk(() => store)).toBe(false);
  });

  it("ignores values it did not write", () => {
    const store = memory();
    store.setItem(LOWER_RISK_KEY, "true");
    expect(readLowerRisk(() => store)).toBeNull();
  });

  it("survives storage that throws", () => {
    expect(readLowerRisk(throwing)).toBeNull();
    expect(saveLowerRisk(throwing, true)).toBe(false);
  });

  it("hides lower-risk files by default only when there is something high-risk", () => {
    expect(lowerRiskShownByDefault([group("critical"), group("normal")])).toBe(false);
    expect(lowerRiskShownByDefault([group("important"), group("low")])).toBe(false);
    expect(lowerRiskShownByDefault([group("normal"), group("low")])).toBe(true);
    expect(lowerRiskShownByDefault([])).toBe(true);
  });
});
