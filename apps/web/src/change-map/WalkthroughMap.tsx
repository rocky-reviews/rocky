/**
 * H4-6 (ADR 0035), Guided walkthrough: the document's walkthrough, stop by stop, over the change
 * map. Each stop lights its part of the map (the renderer's `focus`), dims the rest, puts dots
 * on its edges, and pans and zooms to it (a CSS transform on the map, eased by the stylesheet).
 * The panel beside or under the map says what the stop is about. Back, Next, the stop dots and
 * Play tour move between stops; with reduced motion there is no Play and no easing.
 *
 * The map stays clickable: the transform moves the picture, not its buttons' behaviour.
 */
import { renderChangeMap } from "@rocky-reviews/renderer";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { SafeSvgView } from "./SafeSvg.js";
import { type OpenFile, useMapClicks, useStepTimer, useWidth } from "./map-parts.js";
import { clampStop, fitTransform, stageFor, type TourStop } from "./walkthrough.js";

/** How long a stop shows while the tour plays. */
export const STOP_MS = 6000;

type Props = {
  doc: AnalysisDocument;
  stops: readonly TourStop[];
  onOpenFile: OpenFile;
  reducedMotion: boolean;
};

export const WalkthroughMap = ({ doc, stops, onOpenFile, reducedMotion }: Props) => {
  const clicks = useMapClicks(doc, onOpenFile);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const count = stops.length;
  const current = clampStop(index, count);
  const stop = stops[current];
  const map = useMemo(
    () =>
      renderChangeMap(doc, {
        idPrefix: "brief",
        interactive: { files: clicks.targets.files },
        motion: true,
        ...(stop?.focus === undefined ? {} : { focus: stop.focus }),
      }),
    [doc, clicks.targets, stop],
  );

  const stageRef = useRef<HTMLDivElement>(null);
  const measured = useWidth(stageRef);
  const stage = stageFor(measured === 0 ? map.width : measured, map);
  const focusBox = map.status === "rendered" ? map.focusBox : undefined;
  const t = fitTransform(stage, map, focusBox);

  // A card Tab reached outside the stage scrolls it into view; a new stop starts from the
  // stage's own origin again, so the transform lands where it should.
  useEffect(() => {
    const el = stageRef.current;
    if (el === null) return;
    el.scrollLeft = 0;
    el.scrollTop = 0;
  }, [current]);

  const go = (next: number) => setIndex(clampStop(next, count));
  // Reduced motion switched on mid-tour: the Play button goes, so the tour stops with it.
  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);
  useStepTimer(playing && !reducedMotion, current, STOP_MS, () => {
    if (current >= count - 1) setPlaying(false);
    else {
      go(current + 1);
      if (current + 1 >= count - 1) setPlaying(false);
    }
  });

  if (stop === undefined) return null;
  return (
    <div className="walk">
      <div className="walk-grid">
        <div
          className="walk-stage"
          ref={stageRef}
          style={{ height: stage.height }}
          onClick={clicks.onClick}
          onKeyDown={clicks.onKeyDown}
        >
          <div
            className="walk-pan"
            style={{
              width: map.width,
              transform: `translate(${round(t.x)}px, ${round(t.y)}px) scale(${round(t.scale, 1000)})`,
            }}
          >
            <SafeSvgView svg={map.tree} />
          </div>
        </div>
        <div className="walk-panel">
          <p className="walk-count">
            Stop {current + 1} of {count}
          </p>
          <div className="walk-say" key={stop.id} aria-live="polite">
            <h4 className="walk-heading">
              <bdi>{stop.heading}</bdi>
            </h4>
            <p className="walk-body">
              <bdi>{stop.body}</bdi>
            </p>
          </div>
          <ol className="walk-dots" aria-label="Stops">
            {stops.map((item, i) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="walk-dot"
                  aria-label={`Stop ${i + 1}: ${item.heading}`}
                  aria-current={i === current ? "step" : undefined}
                  onClick={() => go(i)}
                >
                  <span aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <div className="map-controls walk-buttons">
            {/* aria-disabled, not disabled: the button keeps focus when it runs out of stops. */}
            <button
              type="button"
              className="map-btn"
              aria-disabled={current === 0}
              onClick={() => go(current - 1)}
            >
              Back
            </button>
            {!reducedMotion && count > 1 && (
              <button
                type="button"
                className="map-btn"
                aria-pressed={playing}
                onClick={() => {
                  if (!playing && current >= count - 1) go(0);
                  setPlaying((on) => !on);
                }}
              >
                Play tour
              </button>
            )}
            <button
              type="button"
              className="map-btn map-btn-primary"
              aria-disabled={current >= count - 1}
              onClick={() => go(current + 1)}
            >
              Next stop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const round = (value: number, by = 10): number => Math.round(value * by) / by;
