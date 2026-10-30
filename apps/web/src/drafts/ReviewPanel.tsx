/**
 * The right panel's Review tab (P6-4, POC `renderPanel`): how many AI drafts are left to decide,
 * the tally (to decide / your comments / dismissed), the drafts to decide by severity, then the
 * decided ones, the note about dismissals, and the reviewer's own comments. Every item jumps to
 * its draft (or line) in the diff. Ask (P9-2) gets its own tab later.
 */
import type { Finding, Severity } from "@rocky-reviews/schema";
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
export const bySeverity = (findings: readonly Finding[]): Finding[] =>
  findings
    .map((finding, i) => ({ finding, i }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] || a.i - b.i,
    )
    .map((x) => x.finding);

export const ReviewPanelContent = () => {
  const { status, stale, findings, state, decisionOf, focused, jumpToFinding, jumpToComment } =
    useReview();
  const sorted = bySeverity(findings);
  const undecided = sorted.filter((f) => decisionOf(f.id).state === "draft");
  const decided = sorted.filter((f) => decisionOf(f.id).state !== "draft");
  const accepted = decided.filter((f) => decisionOf(f.id).state === "accepted").length;
  const dismissed = decided.length - accepted;
  const yours = accepted + state.comments.length;

  const item = (finding: Finding) => {
    const decision = decisionOf(finding.id);
    const badge =
      decision.state === "draft"
        ? "✦ draft"
        : decision.state === "accepted"
          ? "yours"
          : "dismissed";
    return (
      <li key={finding.id}>
        <button
          type="button"
          className={`f-item st-${decision.state}${focused === finding.id ? " focus" : ""}`}
          disabled={stale}
          onClick={() => jumpToFinding(finding.id)}
        >
          <span className={`dot ${finding.severity}`} aria-hidden="true" />
          <span className="f-text">
            <span className="t">
              <bdi>{finding.title}</bdi>
            </span>
            <span className="loc">
              <bdi>{baseName(finding.path)}</bdi>:{finding.range.end}
            </span>
          </span>
          <span className={`st-badge is-${decision.state}`}>{badge}</span>
          <span className="sr-only">, {SEVERITY_LABEL[finding.severity]} severity</span>
        </button>
      </li>
    );
  };

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
      </button>
    </li>
  );

  return (
    <>
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
                  To decide · by severity
                </h3>
                <ul className="f-list">{undecided.map(item)}</ul>
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
