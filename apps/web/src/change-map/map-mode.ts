/**
 * H4-6 (ADR 0035): what the change map shows for the chosen style. Guided walkthrough needs the
 * document's walkthrough and Flow playback its flows; without them the map falls back to Live
 * traffic with a short notice, so the slot is never blank.
 */
import type { Flow, Graph } from "@rocky-reviews/schema";
import type { MapStyle } from "./map-style.js";
import { type TourStop, tourStops } from "./walkthrough.js";

export type MapMode =
  | { kind: "live"; notice: string | undefined }
  | { kind: "walkthrough"; stops: TourStop[] }
  | { kind: "flows"; flows: Flow[] };

export const NO_WALKTHROUGH =
  "This pull request has no walkthrough, so the map shows live traffic instead.";
export const NO_FLOWS = "This pull request has no flows, so the map shows live traffic instead.";

export const mapModeFor = (style: MapStyle, graph: Graph): MapMode => {
  if (style === "walkthrough") {
    const stops = tourStops(graph);
    return stops.length > 0
      ? { kind: "walkthrough", stops }
      : { kind: "live", notice: NO_WALKTHROUGH };
  }
  if (style === "flows")
    return graph.flows.length > 0
      ? { kind: "flows", flows: graph.flows }
      : { kind: "live", notice: NO_FLOWS };
  return { kind: "live", notice: undefined };
};
