/**
 * The change map's place in the briefing (P6-2): heading, hint, legend and the unavailable
 * state are page HTML here. The map itself is `ChangeMapCanvas`: the renderer's SVG (P5-1),
 * put in the page as React elements from its checked tree (P5-2, ADR 0022), clickable (P5-3).
 * H4-6 (ADR 0035): it plays in the style chosen in the settings (Live traffic, Guided
 * walkthrough or Flow playback), falling back to Live traffic with a notice when the document
 * has no walkthrough or flows.
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { Component, type ReactNode, useMemo } from "react";
import { FlowPlayback } from "../change-map/FlowPlayback.js";
import { LiveMap } from "../change-map/LiveMap.js";
import { type MapMode, mapModeFor } from "../change-map/map-mode.js";
import { type OpenFile, useReducedMotion } from "../change-map/map-parts.js";
import { mapStyleLabel, useMapStyle } from "../change-map/map-style.js";
import { WalkthroughMap } from "../change-map/WalkthroughMap.js";
import { useKeyboard } from "../keyboard/KeyboardContext.js";
import { graphState } from "./briefing-model.js";

type Props = { doc: AnalysisDocument; onOpenFile: OpenFile };

const LIVE: MapMode = { kind: "live", notice: undefined };

export const ChangeMapSlot = ({ doc, onOpenFile }: Props) => {
  const state = graphState(doc);
  const { style } = useMapStyle();
  const mode = useMemo(
    () => (doc.graph === undefined ? LIVE : mapModeFor(style, doc.graph)),
    [style, doc.graph],
  );
  return (
    <section className="section" aria-labelledby="change-map-title">
      <div className="map-head">
        <h3 className="h-eyebrow" id="change-map-title">
          Change map
          {state.kind === "drawn" && (
            <span className="eyebrow-hint">
              <span className="eyebrow-sep" aria-hidden="true">
                ·{" "}
              </span>
              {mode.kind === "flows"
                ? "click a column head to open its file"
                : "click a card to open its file, a badge to open its finding"}
            </span>
          )}
        </h3>
        {doc.graph !== undefined && <MapStyleButton />}
      </div>
      {doc.graph !== undefined ? (
        <>
          <ChangeMapCanvas doc={doc} onOpenFile={onOpenFile} mode={mode} />
          {mode.kind !== "flows" && (
            <ul className="legend" aria-label="Legend">
              <li className="lg-add">New in this PR</li>
              <li className="lg-mod">Changed</li>
              <li className="lg-unch">Existing, untouched</li>
              <li className="lg-hero">Where the change matters</li>
              <li className="lg-find">Open findings</li>
            </ul>
          )}
        </>
      ) : (
        <div className="map-unavailable">
          <p className="map-unavailable-title">Change map unavailable</p>
          {state.kind === "unavailable" && state.reason !== undefined && <p>{state.reason}</p>}
          {state.kind === "unavailable" && state.detail !== undefined && (
            <p>
              <bdi>{state.detail}</bdi>
            </p>
          )}
          <p className="map-unavailable-note">The rest of the briefing is complete without it.</p>
        </div>
      )}
    </section>
  );
};

type CanvasProps = {
  doc: AnalysisDocument;
  onOpenFile: OpenFile;
  /** H4-6: the style to play; Live traffic when not given. */
  mode?: MapMode;
};

/**
 * The renderer's map (P5-1, P5-2) in the page, with click-through (P5-3, ADR 0028): a card
 * opens its file, a finding badge its worst finding (the file, at the finding's line). One
 * click and one keydown listener on the wrapper (React's delegation, no inline handler); the
 * ids under the event are resolved in the document (`change-map/targets.ts`), never used as
 * selectors or URLs. Cards and badges are focusable buttons in the SVG itself, so Tab, Enter
 * and Space work as on any button. H4-6: played in `mode` (`change-map/`).
 */
export const ChangeMapCanvas = ({ doc, onOpenFile, mode = LIVE }: CanvasProps) => (
  <MapBoundary>
    <MapView doc={doc} onOpenFile={onOpenFile} mode={mode} />
  </MapBoundary>
);

/**
 * Says which style plays and opens the settings dialog, where the choice sits with the
 * light/dark mode. Outside the styles, so it stays the same element when the style changes
 * and the dialog can return focus to it.
 */
const MapStyleButton = () => {
  const { style } = useMapStyle();
  const { openHelp } = useKeyboard();
  return (
    <button
      type="button"
      className="map-btn map-btn-quiet"
      aria-haspopup="dialog"
      onClick={openHelp}
    >
      Map style: {mapStyleLabel(style)}
    </button>
  );
};

const MapView = ({ doc, onOpenFile, mode }: Required<CanvasProps>) => {
  const reducedMotion = useReducedMotion();
  switch (mode.kind) {
    case "walkthrough":
      return (
        <WalkthroughMap
          doc={doc}
          stops={mode.stops}
          onOpenFile={onOpenFile}
          reducedMotion={reducedMotion}
        />
      );
    case "flows":
      return (
        <FlowPlayback
          doc={doc}
          flows={mode.flows}
          onOpenFile={onOpenFile}
          reducedMotion={reducedMotion}
        />
      );
    default:
      return (
        <LiveMap
          doc={doc}
          onOpenFile={onOpenFile}
          reducedMotion={reducedMotion}
          notice={mode.notice}
        />
      );
  }
};

/**
 * If the renderer refuses a document (it fails closed, ADR 0022), the briefing keeps working:
 * the map says it is unavailable, with a fixed code. Nothing is logged: the error could quote
 * nothing, but the document it came from is PR content.
 */
export class MapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(): void {
    // Deliberately empty: see above.
  }
  override render(): ReactNode {
    return this.state.failed ? (
      <div className="map-unavailable" role="note">
        <p className="map-unavailable-title">Change map unavailable</p>
        <p>The change map could not be drawn for this analysis.</p>
        <p className="brief-state-code">
          Code: <code>CM-RENDER</code>
        </p>
      </div>
    ) : (
      this.props.children
    );
  }
}
