/**
 * Renders only the rows of a long list that are near the viewport (P6-3). The list scrolls with
 * its nearest scrolling ancestor (the main column), so the sticky file header and the AI strip
 * scroll with it. Heights start as estimates and are replaced by measured ones (ResizeObserver),
 * kept by row key so they survive blocks being inserted. Spacers above and below stand in for
 * the rows that are not rendered; the browser's scroll anchoring keeps the view steady when a
 * measured height differs from its estimate.
 */
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HeightIndex, type Range, visibleRange } from "./windowing.js";

/** Pixels rendered beyond each edge of the viewport, so fast scrolling rarely shows a gap. */
const OVERSCAN = 800;
/** Rows rendered before the first measurement (and in server-rendered markup). */
const INITIAL_ROWS = 80;

const scrollParent = (el: HTMLElement): HTMLElement => {
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return document.scrollingElement instanceof HTMLElement
    ? document.scrollingElement
    : document.documentElement;
};

export type VirtualList = {
  /** Attach to the element that holds the spacers and the rows. */
  listRef: RefObject<HTMLDivElement | null>;
  /** Attach to every rendered row (stable, so rows are observed once). Needs `data-vkey`. */
  measureRef: (el: HTMLElement | null) => (() => void) | undefined;
  range: Range;
  padTop: number;
  padBottom: number;
  /**
   * Scrolls so row `i` is fully visible (if it is not), then renders around it. Pass the row's
   * element when it is rendered: its measured box is exact, the index may still hold estimates.
   */
  reveal: (i: number, el?: HTMLElement) => void;
};

export const useVirtualList = (
  keys: readonly string[],
  estimate: (i: number) => number,
): VirtualList => {
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const measured = useRef(new Map<string, number>());
  const [version, setVersion] = useState(0);

  const index = useMemo(
    () => new HeightIndex(keys.map((key, i) => measured.current.get(key) ?? estimate(i))),
    // `estimate` is a pure function of the row kind, and the keys carry the kinds.
    [keys],
  );
  const position = useMemo(() => new Map(keys.map((key, i) => [key, i])), [keys]);
  const [range, setRange] = useState<Range>(() => ({
    start: 0,
    end: Math.min(keys.length, INITIAL_ROWS),
  }));

  // The latest index for callbacks that outlive a render (scroll, ResizeObserver).
  const latest = useRef({ index, position });
  latest.current = { index, position };

  const update = useCallback(() => {
    const list = listRef.current;
    const scroller = scrollerRef.current;
    if (list === null || scroller === null) return;
    const viewport =
      scroller === document.scrollingElement
        ? { top: 0, height: window.innerHeight }
        : { top: scroller.getBoundingClientRect().top, height: scroller.clientHeight };
    const top = viewport.top - list.getBoundingClientRect().top;
    const next = visibleRange(latest.current.index, top, viewport.height, OVERSCAN);
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  // Recompute whenever the rows or their heights change.
  useLayoutEffect(update, [update, index, version]);

  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const scroller = scrollParent(list);
    scrollerRef.current = scroller;
    let frame = 0;
    const onScroll = () => {
      if (frame === 0)
        frame = requestAnimationFrame(() => {
          frame = 0;
          update();
        });
    };
    const target = scroller === document.scrollingElement ? window : scroller;
    target.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    update();
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [update]);

  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);

  const measureRef = useCallback((el: HTMLElement | null) => {
    if (el === null || typeof ResizeObserver === "undefined") return undefined;
    observer.current ??= new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.vkey;
        if (key === undefined) continue;
        const height =
          entry.borderBoxSize[0]?.blockSize ?? (entry.target as HTMLElement).offsetHeight;
        measured.current.set(key, height);
        const i = latest.current.position.get(key);
        if (i !== undefined && latest.current.index.set(i, height)) changed = true;
      }
      if (changed) setVersion((v) => v + 1);
    });
    const ro = observer.current;
    ro.observe(el);
    return () => ro.unobserve(el);
  }, []);

  const reveal = useCallback(
    (i: number, el?: HTMLElement) => {
      const list = listRef.current;
      const scroller = scrollerRef.current;
      if (list === null || scroller === null) return;
      const { index: heights } = latest.current;
      const box = el?.getBoundingClientRect();
      const rowTop = box?.top ?? list.getBoundingClientRect().top + heights.offsetOf(i);
      const rowBottom = box?.bottom ?? rowTop + heights.get(i);
      const view =
        scroller === document.scrollingElement
          ? { top: 0, bottom: window.innerHeight }
          : scroller.getBoundingClientRect();
      // Leave room for the sticky file header at the top.
      const header = list.closest("article")?.querySelector(".file-head")?.clientHeight ?? 0;
      if (rowTop < view.top + header) scroller.scrollTop -= view.top + header - rowTop;
      else if (rowBottom > view.bottom) scroller.scrollTop += rowBottom - view.bottom;
      update();
    },
    [update],
  );

  return {
    listRef,
    measureRef,
    range,
    padTop: index.offsetOf(range.start),
    padBottom: index.total - index.offsetOf(range.end),
    reveal,
  };
};
