import { useSyncExternalStore } from "react";

/** Whether a media query matches, live. False where there is no matchMedia (tests, SSR). */
export const useMediaQuery = (query: string): boolean =>
  useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia?.(query).matches) || false,
    () => false,
  );

/** The POC's breakpoints: right panel hidden at <= 1180 px, sidebar at <= 760 px. */
export const PANEL_HIDDEN = "(max-width: 1180px)";
export const SIDEBAR_HIDDEN = "(max-width: 760px)";
