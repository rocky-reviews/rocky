/**
 * H4-6 (ADR 0035), Live traffic: the change map with motion. Cards rise in lane by lane,
 * ordinary edges carry slow dashes, the traffic edges (hero, else animated: the renderer's
 * `trafficEdgeIds`) are solid AI cyan with dots travelling along them and a ring on the card
 * they reach, and finding badges pulse. "Traffic only" dims every other edge; "Pause motion"
 * freezes it all. With reduced motion nothing moves (the stylesheet), so there is no Pause.
 */
import { renderChangeMap, trafficEdgeIds } from "@rocky-reviews/renderer";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { useMemo, useState } from "react";
import { MapBox, MapNotice, type OpenFile, useMapClicks } from "./map-parts.js";

type Props = {
  doc: AnalysisDocument;
  onOpenFile: OpenFile;
  reducedMotion: boolean;
  /** Why the chosen style fell back to this one, if it did. */
  notice?: string | undefined;
};

export const LiveMap = ({ doc, onOpenFile, reducedMotion, notice }: Props) => {
  const clicks = useMapClicks(doc, onOpenFile);
  const map = useMemo(
    () =>
      renderChangeMap(doc, {
        idPrefix: "brief",
        interactive: { files: clicks.targets.files },
        motion: true,
      }),
    [doc, clicks.targets],
  );
  const hasTraffic = useMemo(() => trafficEdgeIds(doc.graph?.edges ?? []).size > 0, [doc.graph]);
  const [paused, setPaused] = useState(false);
  const [trafficOnly, setTrafficOnly] = useState(false);
  const switches = [
    ...(paused && !reducedMotion ? ["map-paused"] : []),
    ...(trafficOnly && hasTraffic ? ["map-traffic-only"] : []),
  ];
  return (
    <>
      {notice !== undefined && <MapNotice>{notice}</MapNotice>}
      {(hasTraffic || !reducedMotion) && (
        <div className="map-controls" role="group" aria-label="Map controls">
          {hasTraffic && (
            <button
              type="button"
              className="map-btn"
              aria-pressed={trafficOnly}
              onClick={() => setTrafficOnly((on) => !on)}
            >
              Traffic only
            </button>
          )}
          {!reducedMotion && (
            <button
              type="button"
              className="map-btn"
              aria-pressed={paused}
              onClick={() => setPaused((on) => !on)}
            >
              Pause motion
            </button>
          )}
        </div>
      )}
      <MapBox
        svg={map.tree}
        clicks={clicks}
        {...(switches.length === 0 ? {} : { className: switches.join(" ") })}
      />
    </>
  );
};
