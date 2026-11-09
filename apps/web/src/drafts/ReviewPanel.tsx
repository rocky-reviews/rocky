/**
 * The right panel's Review tab (P6-4, POC `renderPanel`): how many AI drafts are left to decide,
 * the tally (to decide / your comments / dismissed), the drafts to decide (H4-14: the open file's
 * first, by severity, then the other files' by severity; i/u walk them in this order), then the
 * decided ones, the note about dismissals, and the reviewer's own comments. Every item jumps to
 * its draft (or line) in the diff. Ask (P9-2) is the panel's other tab.
 *
 * P8-2b: findings project memory hid are listed under "Hidden by memory", collapsed, each item
 * opening its file on the hidden list; they are not drafts and count in no tally.
 */
import type { Finding, HiddenFinding, Severity } from "@rocky-reviews/schema";
import { useState } from "react";
import type { OwnComment } from "../diff/diff-model.js";
import { SEVERITY_LABEL } from "./DraftCard.js";
import { useReview } from "./ReviewProvider.js";

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** At most `max` characters a person sees (graphemes), then "…"; never cuts inside one. */
export const shorten = (text: string, max: number): string => {
  const parts = Array.from(graphemes.segment(text), (s) => s.segment);
  return parts.length > max ? `${parts.slice(0, max).join("")}…` : text;
};

/** Undecided first is the caller's job; this orders by severity, then document order. */
export const bySeverity = <T extends { readonly severity: Severity }>(
  findings: readonly T[],
): T[] =>
  findings
    .map((finding, i) => ({ finding, i }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] || a.i - b.i,
    )
    .map((x) => x.finding);

/**
 * H4-14: the open file's drafts first, then the other files' in the sidebar's order (`files`)
 * starting after the open file and wrapping round; each file's drafts by severity. Every open
 * file sees a rotation of one cycle, so i/u walking it (and opening each draft's file) visit
 * every draft once, and u undoes i. Files outside `files` follow, in severity order of their
 * first draft. On the briefing (no file open): by severity alone.
 */
export const panelOrder = (
  findings: readonly Finding[],
  current: string | null,
  files: readonly string[] = [],
): Finding[] => {
  const sorted = bySeverity(findings);
  if (current === null) return sorted;
  const all = [...files];
  for (const f of sorted) if (!all.includes(f.path)) all.push(f.path);
  const at = all.indexOf(current);
  const key = (path: string) =>
    path === current ? -1 : (all.indexOf(path) - at - 1 + all.length) % all.length;
  // A stable sort: each file's drafts keep their severity order.
  return sorted
    .map((finding) => ({ finding, k: key(finding.path) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.finding);
};

type Props = {
  /** The file on screen, or null on the briefing. */
  current?: string | null;
  /** The sidebar's file order (k/j's), which the other files' drafts follow. */
  files?: readonly string[];
  /** P9-2: false when the panel's tabs carry the title (the Review tab shows the count). */
  head?: boolean;
};

/** Drafts still to decide (P9-2: the Review tab's count); null until the state is loaded. */
export const undecidedCount = (
  review: Pick<ReturnType<typeof useReview>, "status" | "findings" | "decisionOf" | "postedOf">,
): number | null =>
  review.status !== "ready"
    ? null
    : review.findings.filter(
        (f) => review.decisionOf(f.id).state === "draft" && review.postedOf(f.id) === null,
      ).length;

const NO_FILES: readonly string[] = [];

export const ReviewPanelContent = ({ current = null, files = NO_FILES, head = true }: Props) => {
  const {
    status,
    stale,
    findings,
    hidden,
    state,
    decisionOf,
    postedOf,
    focused,
    jumpToFinding,
    jumpToComment,
    jumpToHidden,
  } = useReview();
  const [showHidden, setShowHidden] = useState(false);
  const sorted = panelOrder(findings, current, files);
  // A draft whose content was already posted (from a re-run of this commit) is decided for
  // every purpose here: nothing can be done with it (P6-6).
  const open = (f: Finding) => decisionOf(f.id).state === "draft" && postedOf(f.id) === null;
  const undecided = sorted.filter(open);
  // The same order as To decide, which is what i/u walk once every draft is decided.
  const decided = sorted.filter((f) => !open(f));
  const here = undecided.filter((f) => f.path === current);
  const elsewhere = undecided.filter((f) => f.path !== current);
  const accepted = decided.filter((f) => decisionOf(f.id).state === "accepted").length;
  const dismissed = decided.length - accepted;
  const yours = accepted + state.comments.length;

  const item = (finding: Finding) => {
    const decision = decisionOf(finding.id);
    const posted = postedOf(finding.id);
    const toDecide = open(finding);
    const badge =
      posted !== null && decision.state !== "dismissed"
        ? "posted"
        : decision.state === "accepted"
          ? "yours"
          : "dismissed";
    return (
      <li key={finding.id}>
        <button
          type="button"
          className={`f-item st-${posted !== null && decision.state === "draft" ? "accepted" : decision.state}${toDecide ? " has-sev" : ""}${focused === finding.id ? " focus" : ""}`}
          disabled={stale}
          onClick={() => jumpToFinding(finding.id)}
        >
          {!toDecide && <span className={`dot ${finding.severity}`} aria-hidden="true" />}
          <span className="f-text">
            <span className="t">
              <bdi>{finding.title}</bdi>
            </span>
            <span className="loc">
              <bdi>{baseName(finding.path)}</bdi>:{finding.range.end}
            </span>
          </span>
          {toDecide ? (
            // H4-14: the severity in words and colour, where the "✦ draft" badge was.
            <span className={`sev ${finding.severity}`}>
              {SEVERITY_LABEL[finding.severity]}
              <span className="sr-only"> severity</span>
            </span>
          ) : (
            <>
              <span className={`st-badge is-${decision.state}`}>{badge}</span>
              <span className="sr-only">, {SEVERITY_LABEL[finding.severity]} severity</span>
            </>
          )}
        </button>
      </li>
    );
  };

  const hiddenItem = (h: HiddenFinding) => (
    <li key={h.id}>
      <button
        type="button"
        className="f-item st-hidden"
        disabled={stale}
        onClick={() => jumpToHidden(h.id)}
      >
        <span className={`dot ${h.severity}`} aria-hidden="true" />
        <span className="f-text">
          <span className="t">
            <bdi>{h.title}</bdi>
          </span>
          <span className="loc">
            <bdi>{baseName(h.path)}</bdi>:{h.range.end}
          </span>
        </span>
        <span className="st-badge is-hidden">hidden</span>
        <span className="sr-only">, {SEVERITY_LABEL[h.severity]} severity</span>
      </button>
    </li>
  );

  const comment = (c: OwnComment) => (
    <li key={c.id}>
      <button
        type="button"
        className="f-item st-accepted"
        disabled={stale}
        onClick={() => jumpToComment(c)}
      >
        <span className="f-text">
          <span className="t">
            <bdi>{shorten(c.body, 70)}</bdi>
          </span>
          <span className="loc">
            <bdi>{baseName(c.path)}</bdi>:{c.line}
          </span>
        </span>
        {c.posted !== null && <span className="st-badge is-accepted">posted</span>}
      </button>
    </li>
  );

  return (
    <>
      {head && (
        <div className="panel-head">
          <h2 className="panel-title">
            Review
            {status === "ready" && undecided.length > 0 && (
              <span className="panel-count">
                {" "}
                · {undecided.length}
                <span className="sr-only"> AI drafts to decide</span>
              </span>
            )}
          </h2>
        </div>
      )}
      <div className="panel-body">
        {status === "none" && (
          <p className="placeholder">
            AI drafts and your own comments for this pull request appear here.
          </p>
        )}
        {status === "loading" && (
          <p className="placeholder" role="status">
            Loading your drafts…
          </p>
        )}
        {status === "failed" && (
          <p className="panel-error" role="alert">
            Your drafts and comments could not be loaded. Reload the page to try again.
          </p>
        )}
        {status === "ready" && (
          <>
            {stale && (
              <p className="placeholder" role="note">
                These drafts and your comments are for an earlier push, so they are hidden on the
                new diff.
              </p>
            )}
            <dl className="tally">
              <div className="tally-ai">
                <dt>AI drafts to decide</dt>
                <dd>{undecided.length}</dd>
              </div>
              <div className="tally-you">
                <dt>Your comments</dt>
                <dd>{yours}</dd>
              </div>
              <div className="tally-dismissed">
                <dt>Dismissed</dt>
                <dd>{dismissed}</dd>
              </div>
            </dl>
            {undecided.length > 0 ? (
              <section aria-labelledby="to-decide">
                <h3 className="sub-h" id="to-decide">
                  To decide
                </h3>
                {here.length > 0 && elsewhere.length > 0 ? (
                  <>
                    <h4 className="sub-group" id="to-decide-here">
                      This file
                    </h4>
                    <ul className="f-list" aria-labelledby="to-decide-here">
                      {here.map(item)}
                    </ul>
                    <h4 className="sub-group" id="to-decide-elsewhere">
                      Other files
                    </h4>
                    <ul className="f-list" aria-labelledby="to-decide-elsewhere">
                      {elsewhere.map(item)}
                    </ul>
                  </>
                ) : (
                  <ul className="f-list">{undecided.map(item)}</ul>
                )}
              </section>
            ) : (
              findings.length > 0 && <p className="good">✓ Every AI draft has a decision.</p>
            )}
            {findings.length === 0 && (
              <p className="placeholder">The AI drafted no comments for this pull request.</p>
            )}
            {decided.length > 0 && (
              <section aria-labelledby="decided">
                <h3 className="sub-h" id="decided">
                  Decided
                </h3>
                <ul className="f-list">{decided.map(item)}</ul>
              </section>
            )}
            {hidden.length > 0 && (
              <section aria-labelledby="hidden-by-memory" className="hidden-section">
                <h3 className="sub-h" id="hidden-by-memory">
                  Hidden by memory
                </h3>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost hidden-toggle"
                  aria-expanded={showHidden}
                  aria-controls="hidden-by-memory-list"
                  onClick={() => setShowHidden((v) => !v)}
                >
                  <span className="mark" aria-hidden="true">
                    ◆
                  </span>{" "}
                  {hidden.length} {hidden.length === 1 ? "finding" : "findings"} hidden by memory ·{" "}
                  {showHidden ? "hide" : "show"}
                </button>
                {showHidden && (
                  <ul className="f-list" id="hidden-by-memory-list">
                    {bySeverity(hidden).map(hiddenItem)}
                  </ul>
                )}
              </section>
            )}
            {dismissed > 0 && (
              <p className="learn">
                <span className="mark" aria-hidden="true">
                  ◆
                </span>{" "}
                Rocky keeps the reason for {dismissed}{" "}
                {dismissed === 1 ? "dismissal" : "dismissals"} so future reviews of this repository
                can learn from {dismissed === 1 ? "it" : "them"}.
              </p>
            )}
            {state.comments.length > 0 && (
              <section aria-labelledby="own-comments">
                <h3 className="sub-h" id="own-comments">
                  Your own comments
                </h3>
                <ul className="f-list">{state.comments.map(comment)}</ul>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
};
