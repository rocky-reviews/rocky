/**
 * H4-14: a, e and d act on the focused draft only while the reviewer can see it, and their hints
 * (on the card and in the shortcut strip) show only then. "On screen" is the same test in both
 * places: some of the card is inside the main column's viewport, below the sticky file header.
 *
 * The focused card watches itself with one IntersectionObserver and reports here; the strip
 * reads it. Its own provider, so a report re-renders the strip and the card, not the page. The
 * keys check the card's box when pressed (`cardOnScreen`), so they never wait for the observer.
 */
import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

type DraftOnScreen = {
  /** The focused draft, while it is on screen with its actions. */
  readonly onScreen: string | null;
  readonly report: (id: string, visible: boolean) => void;
};

export const DraftOnScreenContext = createContext<DraftOnScreen>({
  onScreen: null,
  report: () => {},
});

export const DraftOnScreenProvider = ({ children }: { children: ReactNode }) => {
  const [onScreen, setOnScreen] = useState<string | null>(null);
  const report = useCallback(
    (id: string, visible: boolean) =>
      setOnScreen((current) => (visible ? id : current === id ? null : current)),
    [],
  );
  const value = useMemo(() => ({ onScreen, report }), [onScreen, report]);
  return <DraftOnScreenContext value={value}>{children}</DraftOnScreenContext>;
};

export const useDraftOnScreen = (): string | null => useContext(DraftOnScreenContext).onScreen;

const mainOf = (card: Element): HTMLElement | null => card.closest<HTMLElement>("#main");
const fileHeadOf = (card: Element): HTMLElement | null =>
  card.parentElement?.closest("article")?.querySelector<HTMLElement>(".file-head") ?? null;

/** Whether some of the card is in the main column's viewport, below the sticky file header. */
export const cardOnScreen = (card: Element): boolean => {
  const main = mainOf(card);
  const view = main?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  const top = Math.max(view.top, fileHeadOf(card)?.getBoundingClientRect().bottom ?? view.top);
  const box = card.getBoundingClientRect();
  return box.bottom > top && box.top < view.bottom;
};

/** While `active`, reports whether the card in `ref` is on screen, as the reviewer scrolls. */
export const useReportOnScreen = (
  ref: RefObject<HTMLElement | null>,
  id: string,
  active: boolean,
): void => {
  const { report } = useContext(DraftOnScreenContext);
  useEffect(() => {
    const card = ref.current;
    if (!active || card === null || typeof IntersectionObserver === "undefined") return;
    // The header's height stands in for where it sticks: a card never sits above it.
    const header = fileHeadOf(card)?.offsetHeight ?? 0;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry !== undefined) report(id, entry.isIntersecting);
      },
      { root: mainOf(card), rootMargin: `-${header}px 0px 0px 0px` },
    );
    observer.observe(card);
    return () => {
      observer.disconnect();
      report(id, false);
    };
  }, [ref, id, active, report]);
};
