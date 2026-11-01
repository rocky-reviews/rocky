/**
 * H4-6: what the three map styles share. Click-through (P5-3, ADR 0028) is one click and one
 * keydown listener on the box around the SVG; the ids under the event are resolved in the
 * document (`targets.ts`), never used as selectors or URLs. The controls are plain buttons.
 */
import type { SafeSvg } from "@rocky-reviews/renderer";
import type { AnalysisDocument } from "@rocky-reviews/schema";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMediaQuery } from "../shell/use-media-query.js";
import { SafeSvgView } from "./SafeSvg.js";
import { type MapTargets, mapTargets, targetAt } from "./targets.js";

export type OpenFile = (path: string, line?: number) => void;

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether the person asked for less motion; live, so the map follows a change. */
export const useReducedMotion = (): boolean => useMediaQuery(REDUCED_MOTION);

export type MapClicks = {
  targets: MapTargets;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

/** A card opens its file, a finding badge its worst finding (ADR 0028). */
export const useMapClicks = (doc: AnalysisDocument, onOpenFile: OpenFile): MapClicks => {
  const targets = useMemo(() => mapTargets(doc), [doc]);
  const open = (root: Element, target: EventTarget | null): boolean => {
    const hit = targetAt(root, target, targets);
    if (hit === undefined) return false;
    if (hit.line === undefined) onOpenFile(hit.path);
    else onOpenFile(hit.path, hit.line);
    return true;
  };
  return {
    targets,
    onClick: (event) => {
      open(event.currentTarget, event.target);
    },
    onKeyDown: (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (!(event.target instanceof Element) || event.target.getAttribute("role") !== "button")
        return;
      // Space would scroll the page; Enter has nothing else to do here.
      if (open(event.currentTarget, event.target)) event.preventDefault();
    },
  };
};

/**
 * The map in its sideways-scrolling box (P6-8), as before H4-6. `className` carries the page's
 * motion switches (`map-paused`, `map-traffic-only`).
 */
export const MapBox = ({
  svg,
  clicks,
  className,
}: {
  svg: SafeSvg;
  clicks: MapClicks;
  className?: string;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const overflows = useOverflow(box, svg);
  return (
    <>
      {/* The listeners only delegate: the focusable controls are the SVG buttons inside. */}
      <div
        className={className === undefined ? "map-scroll" : `map-scroll ${className}`}
        ref={box}
        onClick={clicks.onClick}
        onKeyDown={clicks.onKeyDown}
      >
        <SafeSvgView svg={svg} />
      </div>
      {overflows && (
        <p className="map-scroll-hint">
          Scroll sideways to see the whole map <span aria-hidden="true">→</span>
        </p>
      )}
    </>
  );
};

/**
 * P6-8: whether the box is narrower than its content (the map scrolls sideways on phones), so
 * the page can say so; nothing else shows that part of the map is out of view. Both the box and
 * the map inside it are watched, and a new map (`content`) checks again.
 */
const useOverflow = (ref: RefObject<HTMLElement | null>, content: unknown): boolean => {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const check = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    return () => observer.disconnect();
  }, [ref, content]);
  return overflows;
};

/** An element's inner width, live; 0 until it is measured (and where nothing measures). */
export const useWidth = (ref: RefObject<HTMLElement | null>): number => {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
};

/**
 * Calls `onTick` once `ms` after `running` turns on or `key` changes, again after each change,
 * until `running` turns off. The latest `onTick` is used, so it need not be stable.
 */
export const useStepTimer = (
  running: boolean,
  key: unknown,
  ms: number,
  onTick: () => void,
): void => {
  const tick = useRef(onTick);
  useEffect(() => {
    tick.current = onTick;
  });
  useEffect(() => {
    if (!running) return;
    const id = setTimeout(() => tick.current(), ms);
    return () => clearTimeout(id);
  }, [running, key, ms]);
};

/** A notice above the map (a missing walkthrough or flows). */
export const MapNotice = ({ children }: { children: ReactNode }) => (
  <p className="map-notice" role="note">
    {children}
  </p>
);
