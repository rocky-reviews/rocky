/**
 * Light/dark: the saved choice wins, otherwise the system preference (and its changes).
 * `public/theme-init.js` applies the same rule before the first paint; this module takes over
 * once the app runs. Storage can throw (blocked, private mode, quota), so every access is
 * guarded and the theme still works without it, just unremembered.
 */
export type Mode = "light" | "dark";

export const STORAGE_KEY = "rocky-mode";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

const isMode = (value: unknown): value is Mode => value === "light" || value === "dark";

export const resolveMode = (saved: unknown, systemDark: boolean): Mode =>
  isMode(saved) ? saved : systemDark ? "dark" : "light";

export const readSavedMode = (storage: () => Storage): Mode | null => {
  try {
    const value = storage().getItem(STORAGE_KEY);
    return isMode(value) ? value : null;
  } catch {
    return null;
  }
};

/** Returns whether the choice was stored. */
export const saveMode = (storage: () => Storage, mode: Mode): boolean => {
  try {
    storage().setItem(STORAGE_KEY, mode);
    return true;
  } catch {
    return false;
  }
};

export const applyMode = (root: HTMLElement, mode: Mode): void => {
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
};

export const otherMode = (mode: Mode): Mode => (mode === "dark" ? "light" : "dark");
