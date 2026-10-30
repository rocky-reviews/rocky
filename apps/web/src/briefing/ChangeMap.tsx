/**
 * The change map's place in the briefing (P6-2): heading, hint, legend and the unavailable
 * state are page HTML here. The map itself is `ChangeMapCanvas`: the renderer's SVG (P5-1),
 * put in the page as React elements from its checked tree (P5-2, ADR 0022), clickable (P5-3).
 */
import { renderChangeMap } from "@rocky-reviews/renderer";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { Component, type KeyboardEvent, type MouseEvent, type ReactNode, useMemo } from "react";
import { SafeSvgView } from "../change-map/SafeSvg.js";
import { mapTargets, targetAt } from "../change-map/targets.js";
import { graphState } from "./briefing-model.js";

type Props = { doc: AnalysisDocument; onOpenFile: (path: string, line?: number) => void };

export const ChangeMapSlot = ({ doc, onOpenFile }: Props) => {
  const state = graphState(doc);
  return (
    <section className="section" aria-labelledby="change-map-title">
      <h3 className="h-eyebrow" id="change-map-title">
        Change map
        {state.kind === "drawn" && (
          <span className="eyebrow-hint">
            · click a card to open its file, a badge to open its finding
          </span>
        )}
      </h3>
      {doc.graph !== undefined ? (
        <>
          <ChangeMapCanvas doc={doc} onOpenFile={onOpenFile} />
          <ul className="legend" aria-label="Legend">
            <li className="lg-add">New in this PR</li>
            <li className="lg-mod">Changed</li>
            <li className="lg-unch">Existing, untouched</li>
            <li className="lg-hero">Where the change matters</li>
            <li className="lg-find">Open findings</li>
          </ul>
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
  onOpenFile: (path: string, line?: number) => void;
};

/**
 * The renderer's map (P5-1, P5-2) in the page, with click-through (P5-3, ADR 0028): a card
 * opens its file, a finding badge its worst finding (the file, at the finding's line). One
 * click and one keydown listener on the wrapper (React's delegation, no inline handler); the
 * ids under the event are resolved in the document (`change-map/targets.ts`), never used as
 * selectors or URLs. Cards and badges are focusable buttons in the SVG itself, so Tab, Enter
 * and Space work as on any button.
 */
export const ChangeMapCanvas = ({ doc, onOpenFile }: CanvasProps) => (
  <MapBoundary>
    <MapView doc={doc} onOpenFile={onOpenFile} />
  </MapBoundary>
);

const MapView = ({ doc, onOpenFile }: CanvasProps) => {
  const targets = useMemo(() => mapTargets(doc), [doc]);
  const map = useMemo(
    () => renderChangeMap(doc, { idPrefix: "brief", interactive: { files: targets.files } }),
    [doc, targets],
  );
  const open = (root: Element, target: EventTarget | null): boolean => {
    const hit = targetAt(root, target, targets);
    if (hit === undefined) return false;
    if (hit.kind === "file") onOpenFile(hit.path);
    else onOpenFile(hit.path, hit.line);
    return true;
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    open(event.currentTarget, event.target);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!(event.target instanceof Element) || event.target.getAttribute("role") !== "button")
      return;
    // Space would scroll the page; Enter has nothing else to do here.
    if (open(event.currentTarget, event.target)) event.preventDefault();
  };
  return (
    // The listeners only delegate: the focusable controls are the SVG buttons inside.
    <div className="map-scroll" onClick={onClick} onKeyDown={onKeyDown}>
      <SafeSvgView svg={map.tree} />
    </div>
  );
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
