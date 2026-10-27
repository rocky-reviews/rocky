import { useCallback, useEffect, useState } from "react";
import {
  applyMode,
  DARK_QUERY,
  type Mode,
  otherMode,
  readSavedMode,
  resolveMode,
  saveMode,
} from "../theme.js";

const storage = (): Storage => window.localStorage;

const initialMode = (): Mode => {
  if (typeof document === "undefined") return "light";
  const set = document.documentElement.dataset.mode;
  if (set === "light" || set === "dark") return set;
  return resolveMode(readSavedMode(storage), window.matchMedia?.(DARK_QUERY).matches ?? false);
};

/** The current mode and a toggle that remembers the choice in this browser. */
export const useTheme = (): { mode: Mode; toggle: () => void } => {
  const [mode, setMode] = useState<Mode>(initialMode);

  useEffect(() => applyMode(document.documentElement, mode), [mode]);

  // Without a saved choice, follow the system when it changes.
  useEffect(() => {
    const list = window.matchMedia?.(DARK_QUERY);
    if (!list) return;
    const onChange = (event: MediaQueryListEvent) => {
      if (readSavedMode(storage) === null) setMode(event.matches ? "dark" : "light");
    };
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    const next = otherMode(mode);
    saveMode(storage, next);
    setMode(next);
  }, [mode]);

  return { mode, toggle };
};
