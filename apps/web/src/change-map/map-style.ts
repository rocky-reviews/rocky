/**
 * H4-6 (ADR 0035): how the change map plays, chosen per browser like the light/dark mode
 * (theme.ts): Live traffic (the default), Guided walkthrough or Flow playback. Storage can throw
 * (blocked, private mode, quota), so every access is guarded; without it the choice still works,
 * just unremembered. Only a value this module writes is read back.
 */
import { createContext, useContext } from "react";

export type MapStyle = "live" | "walkthrough" | "flows";

export const MAP_STYLE_KEY = "rocky-map-style";
export const DEFAULT_MAP_STYLE: MapStyle = "live";

/** In the order the setting lists them. */
export const MAP_STYLES: readonly { value: MapStyle; label: string; hint: string }[] = [
  { value: "live", label: "Live traffic", hint: "The map, with the important connections moving." },
  {
    value: "walkthrough",
    label: "Guided walkthrough",
    hint: "The AI's tour of the change, one stop at a time.",
  },
  { value: "flows", label: "Flow playback", hint: "Each flow as a sequence, step by step." },
];

export const mapStyleLabel = (style: MapStyle): string =>
  MAP_STYLES.find((option) => option.value === style)?.label ?? "Live traffic";

export const isMapStyle = (value: unknown): value is MapStyle =>
  value === "live" || value === "walkthrough" || value === "flows";

export const readMapStyle = (storage: () => Storage): MapStyle => {
  try {
    const value = storage().getItem(MAP_STYLE_KEY);
    return isMapStyle(value) ? value : DEFAULT_MAP_STYLE;
  } catch {
    return DEFAULT_MAP_STYLE;
  }
};

/** Returns whether the choice was stored. */
export const saveMapStyle = (storage: () => Storage, style: MapStyle): boolean => {
  try {
    storage().setItem(MAP_STYLE_KEY, style);
    return true;
  } catch {
    return false;
  }
};

export type MapStyleSetting = {
  readonly style: MapStyle;
  readonly setStyle: (style: MapStyle) => void;
  /** False once saving failed: the choice then lasts until a reload. */
  readonly remembered: boolean;
};

/** The shell owns the setting; without it (tests, other pages) the map plays Live traffic. */
export const MapStyleContext = createContext<MapStyleSetting>({
  style: DEFAULT_MAP_STYLE,
  setStyle: () => {},
  remembered: true,
});

export const useMapStyle = (): MapStyleSetting => useContext(MapStyleContext);
