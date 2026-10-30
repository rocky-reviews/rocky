/**
 * The page's one keydown listener for shortcuts (P6-5, ADR 0030). Rendered inside the review
 * provider so n/p and a/e/d go through the same paths as the mouse: n/p are the right panel's
 * jump to a draft, and a/e/d press the focused draft card's own Accept/Edit/Dismiss button, so
 * whatever guards the card has (a disabled or missing button) apply to the key too.
 */
import { useEffect, useRef } from "react";
import { bySeverity } from "../drafts/ReviewPanel.js";
import { useReview } from "../drafts/ReviewProvider.js";
import { isTextEntry, type ShortcutAction, shortcutFor, stepDraft, stepFile } from "./keymap.js";

type Props = {
  /** False while a modal (drawer, dialog) is open: nothing fires behind it. */
  active: boolean;
  singleKeys: boolean;
  /** The file on screen, or null on the briefing. */
  current: string | null;
  /** k/j order: the sidebar's, noise last. */
  order: readonly string[];
  onOpen: (path: string | null) => void;
  onToggleViewed: (path: string) => void;
  onToggleMode: () => void;
  onHelp: () => void;
  onAsk: () => void;
  onFinish: () => void;
};

const ROLE = { accept: "accept", edit: "edit", dismiss: "dismiss" } as const;

export const ShortcutKeys = (props: Props) => {
  const review = useReview();
  const latest = useRef({ props, review });
  latest.current = { props, review };

  useEffect(() => {
    if (!props.active) return;
    const run = (action: ShortcutAction): boolean => {
      const { props: p, review: r } = latest.current;
      switch (action) {
        case "nextFile":
        case "prevFile": {
          const to = stepFile(p.order, p.current, action === "nextFile" ? 1 : -1);
          if (to !== p.current) p.onOpen(to);
          return true;
        }
        case "nextDraft":
        case "prevDraft": {
          const ids = bySeverity(r.findings).map((f) => f.id);
          const undecided = (id: string) => r.decisionOf(id).state === "draft";
          const to = stepDraft(ids, undecided, r.focused, action === "nextDraft" ? 1 : -1);
          if (to !== undefined) r.jumpToFinding(to);
          return true;
        }
        case "accept":
        case "edit":
        case "dismiss": {
          const finding = r.findings.find((f) => f.id === r.focused);
          if (finding === undefined || finding.path !== p.current) return true;
          const card = document.querySelector(`[data-finding="${CSS.escape(finding.id)}"]`);
          if (card === null) {
            // Scrolled out of the (virtualised) diff: bring it back; the next press acts.
            if (r.decisionOf(finding.id).state === "draft") r.jumpToFinding(finding.id);
            return true;
          }
          // No such button (the card is being edited or dismissed): the key does nothing.
          const button = card.querySelector<HTMLButtonElement>(`[data-role="${ROLE[action]}"]`);
          if (button !== null && !button.disabled) button.click();
          return true;
        }
        case "viewed":
          if (p.current !== null) p.onToggleViewed(p.current);
          return true;
        case "briefing":
          p.onOpen(null);
          return true;
        case "mode":
          p.onToggleMode();
          return true;
        case "help":
          p.onHelp();
          return true;
        case "ask":
          p.onAsk();
          return true;
        case "finish":
          p.onFinish();
          return true;
      }
    };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (isTextEntry(target)) return;
      const action = shortcutFor(event, latest.current.props.singleKeys);
      if (action !== null && run(action)) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.active]);

  return null;
};
