/**
 * H4-9: whether the sidebar lists the lower-risk files (Normal, Low and noise), chosen per
 * browser like the change map style (map-style.ts). Hidden by default when there is something
 * high-risk to read first. Storage can throw (blocked, private mode, quota), so every access is
 * guarded; without it the toggle still works, just unremembered. Only a value this module writes
 * is read back.
 */
import type { SidebarGroup } from "./triage-model.js";

export const LOWER_RISK_KEY = "rocky-sidebar-lower-risk";

/** The saved choice: true shown, false hidden, null when nothing usable is stored. */
export const readLowerRisk = (storage: () => Storage): boolean | null => {
  try {
    const value = storage().getItem(LOWER_RISK_KEY);
    return value === "shown" ? true : value === "hidden" ? false : null;
  } catch {
    return null;
  }
};

/** Returns whether the choice was stored. */
export const saveLowerRisk = (storage: () => Storage, shown: boolean): boolean => {
  try {
    storage().setItem(LOWER_RISK_KEY, shown ? "shown" : "hidden");
    return true;
  } catch {
    return false;
  }
};

/** Without a saved choice: hidden, unless there is no Critical or Important file to show. */
export const lowerRiskShownByDefault = (groups: readonly SidebarGroup[]): boolean =>
  !groups.some((g) => (g.level === "critical" || g.level === "important") && g.files.length > 0);

export const isLowerRisk = (level: SidebarGroup["level"]): boolean =>
  level === "normal" || level === "low";
