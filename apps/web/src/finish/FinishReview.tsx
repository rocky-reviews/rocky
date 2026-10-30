/**
 * The Finish review modal (P6-6, ADR 0031, POC `openFinish`): the coverage warning (high-risk
 * files not marked viewed) or its success line, the undecided-drafts warning, the exact list of
 * what will be posted, an overall comment with a drafted summary on request, the verdict with a
 * suggestion, and Keep reviewing / Submit review.
 *
 * The list is the server's (`GET …/review`, P3-5): every item's body is shown as the Markdown
 * source GitHub will receive, as text, so nothing a rendering could hide (a link's target, an
 * image, a mention) is hidden. Submit sends that list's digest and head with a fresh key, once
 * per click: the button is inert while it arms, disabled while the request runs, and a ref
 * guards the same frame; the server's idempotency guards the rest. Escape and Keep reviewing
 * close it without sending anything; while the request runs, nothing closes it. A modal like
 * the shortcuts dialog: the shell makes the page inert, Tab stays inside, focus starts on Close
 * and goes back to the opener on close.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  previewOutcome,
  type PreviewOutcome,
  type ReviewPostingSource,
  type ReviewPreview,
  type ReviewVerdict,
  type SubmitOutcome,
  submitOutcome,
} from "../data/posting-data.js";
import type { PullSummary } from "../data/shell-data.js";
import { useReview } from "../drafts/ReviewProvider.js";
import { pullRequestUrl } from "../lib/github-url.js";
import { timeAgo } from "../lib/time.js";
import { trapTab } from "../shell/focus-trap.js";
import type { SidebarGroup } from "../shell/triage-model.js";
import {
  attemptText,
  draftSummary,
  itemLocation,
  noticeFor,
  REFUSAL_TEXT,
  seriousAccepted,
  suggestVerdict,
  undecidedCount,
  unviewedHighRisk,
  VERDICT_HINT,
  VERDICT_LABEL,
} from "./finish-model.js";

/** How long Submit stays inert after the modal opens (a double-click on the opener). */
export const ARM_MS = 400;

const VERDICTS: readonly ReviewVerdict[] = ["comment", "approve", "request_changes"];

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

type Loaded =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly preview: ReviewPreview }
  | { readonly kind: "failed"; readonly outcome: Exclude<PreviewOutcome, { kind: "ok" }> };

type Props = {
  /** Null when the page's data source has no pull request id: nothing can be posted. */
  pullRequestId: string | null;
  pull: PullSummary;
  /** The person's GitHub login in this org, for "as @login"; null until the session is read. */
  login: string | null;
  posting: ReviewPostingSource;
  groups: readonly SidebarGroup[];
  viewed: ReadonlySet<string>;
  now: number;
  onClose: () => void;
  /** The review is on GitHub; the shell updates the status pill and closes the modal. */
  onPosted: (verdict: ReviewVerdict) => void;
};

export const FinishReview = ({
  pullRequestId,
  pull,
  login,
  posting,
  groups,
  viewed,
  now,
  onClose,
  onPosted,
}: Props) => {
  const review = useReview();
  const closeButton = useRef<HTMLButtonElement>(null);
  const noticeBox = useRef<HTMLParagraphElement>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [verdict, setVerdict] = useState<ReviewVerdict | null>(null);
  const [picked, setPicked] = useState(false);
  const [summary, setSummary] = useState("");
  const [drafted, setDrafted] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const sent = useRef(false);
  const alive = useRef(true);
  const [generation, setGeneration] = useState(0);
  const reloadPreview = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => closeButton.current?.focus(), []);

  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // The exact list, from the server, each time the modal opens or is told to look again.
  useEffect(() => {
    if (pullRequestId === null) return;
    const abort = new AbortController();
    setLoaded({ kind: "loading" });
    posting.preview(pullRequestId, { signal: abort.signal }).then(
      (answer) => {
        if (abort.signal.aborted) return;
        const outcome = previewOutcome(answer);
        setLoaded(
          outcome.kind === "ok"
            ? { kind: "ready", preview: outcome.preview }
            : { kind: "failed", outcome },
        );
      },
      () =>
        !abort.signal.aborted &&
        setLoaded({ kind: "failed", outcome: { kind: "error", status: 0 } }),
    );
    return () => abort.abort();
  }, [posting, pullRequestId, generation]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!sending) onClose();
      }
      if (event.key === "Tab") trapTab(event, "#finish-dialog");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  const preview = loaded.kind === "ready" ? loaded.preview : null;
  const items = preview?.items ?? [];
  const unviewed = useMemo(() => unviewedHighRisk(groups, viewed), [groups, viewed]);
  const undecided = undecidedCount(review.findings, review.state);
  const suggestion = useMemo(
    () =>
      preview === null
        ? null
        : suggestVerdict({
            serious: seriousAccepted(review.findings, review.state),
            items: preview.items.length,
            unviewed: unviewed.length,
            undecided,
          }),
    [preview, review.findings, review.state, unviewed.length, undecided],
  );

  // The suggestion pre-selects its option until the person picks one themselves.
  useEffect(() => {
    if (picked || suggestion === null || !suggestion.preselect) return;
    setVerdict(suggestion.verdict);
  }, [picked, suggestion]);

  const nothingToSay = items.length === 0 && summary.trim() === "" && verdict !== "approve";
  const blocked =
    preview === null
      ? loaded.kind === "loading"
        ? "Loading what will be posted…"
        : null
      : !preview.revisionKnown
        ? REFUSAL_TEXT.no_revision
        : verdict === null
          ? "Pick a verdict to submit."
          : nothingToSay
            ? "Write a summary or pick Approve to submit: there is nothing to post yet."
            : null;
  const canSubmit = preview !== null && verdict !== null && blocked === null && !sending;

  const close = () => {
    if (!sending) onClose();
  };

  const draft = () => {
    const text = draftSummary(items);
    if (text === null) return;
    setSummary(text);
    setDrafted(text);
    document.getElementById("finish-summary")?.focus();
  };

  const submit = async () => {
    if (!armed || sent.current || !canSubmit || preview === null || verdict === null) return;
    if (pullRequestId === null) return;
    sent.current = true;
    setSending(true);
    setNotice(null);
    let outcome: SubmitOutcome;
    try {
      outcome = submitOutcome(
        await posting.submit(pullRequestId, {
          // A fresh key per click: the same click again answers the same, never posts twice.
          idempotencyKey: crypto.randomUUID(),
          contentSha256: preview.contentSha256,
          headSha: preview.headSha,
          verdict,
          body: summary,
        }),
      );
    } catch {
      // The request did not complete: it may or may not have reached the server.
      outcome = { kind: "error", status: 0 };
    }
    if (!alive.current) return;
    if (outcome.kind === "posted") {
      // Stays sent: the shell closes this; nothing can post again from here.
      review.reload();
      onPosted(verdict);
      return;
    }
    sent.current = false;
    setSending(false);
    setNotice(noticeFor(outcome));
    // The list may have changed (stale, moved head, an attempt that settled or is in flight, or
    // the items released by a refusal): show it as the server has it now.
    if (outcome.kind !== "invalid") reloadPreview();
    if (outcome.kind === "post_unknown" || outcome.kind === "error") review.reload();
    window.requestAnimationFrame(() => noticeBox.current?.focus());
  };

  const who = login === null ? "you" : `@${login}`;
  const githubUrl = pullRequestUrl(pull);

  return (
    <div className="modal-layer">
      <div className="scrim" aria-hidden="true" onClick={close} />
      <div
        id="finish-dialog"
        className="modal finish-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finish-title"
        aria-busy={sending}
      >
        <div className="modal-head">
          <h2 id="finish-title">Finish your review</h2>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label="Close"
            ref={closeButton}
            disabled={sending}
            onClick={close}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        {notice !== null && (
          <p className="modal-section finish-notice" role="alert" tabIndex={-1} ref={noticeBox}>
            {notice}{" "}
            {githubUrl !== undefined && (
              <a href={githubUrl} target="_blank" rel="noopener noreferrer">
                Open on GitHub<span className="sr-only"> (opens in a new tab)</span>
              </a>
            )}
          </p>
        )}

        <div className="modal-section finish-warnings">
          {unviewed.length > 0 ? (
            <p className="finish-warn">
              <b>
                {unviewed.length} high-risk {unviewed.length === 1 ? "file" : "files"} not marked
                viewed:
              </b>{" "}
              {unviewed.map((path, i) => (
                <span key={path}>
                  {i > 0 && ", "}
                  <code title={path}>
                    <bdi>{baseName(path)}</bdi>
                  </code>
                </span>
              ))}
            </p>
          ) : (
            <p className="finish-good">✓ You reviewed every Critical and Important file.</p>
          )}
          {undecided > 0 && (
            <p className="finish-warn">
              <b>
                {undecided} AI {undecided === 1 ? "draft" : "drafts"} still undecided.
              </b>{" "}
              They won&apos;t be posted. Only what you accepted goes out.
            </p>
          )}
        </div>

        <section className="modal-section finish-list" aria-labelledby="finish-list-title">
          <h3 className="h-eyebrow" id="finish-list-title">
            Will be posted to GitHub as <bdi>{who}</bdi>
            {preview !== null && ` (${items.length})`}
          </h3>
          {pullRequestId === null && (
            <p className="finish-problem">Posting is not available for this pull request.</p>
          )}
          {loaded.kind === "loading" && pullRequestId !== null && (
            <p className="finish-muted" role="status">
              Loading what will be posted…
            </p>
          )}
          {loaded.kind === "failed" && (
            <p className="finish-problem" role="alert">
              {loaded.outcome.kind === "unavailable"
                ? "Posting is not available on this server yet."
                : loaded.outcome.kind === "not_found"
                  ? "This pull request is no longer available to you."
                  : loaded.outcome.kind === "signed_out"
                    ? "You are signed out. Sign in again to post."
                    : "The list of what will be posted could not be loaded."}{" "}
              {(loaded.outcome.kind === "error" || loaded.outcome.kind === "unavailable") && (
                <button type="button" className="btn btn-sm" onClick={reloadPreview}>
                  Try again
                </button>
              )}
            </p>
          )}
          {preview !== null && (
            <>
              {preview.inFlight !== null && (
                <p className="finish-warn" role="status">
                  <b>An earlier attempt is still being confirmed with GitHub</b> (
                  {attemptText(preview.inFlight)}, {timeAgo(preview.inFlight.createdAt, now)}). Its
                  comments are not listed below. Check the pull request on GitHub before you post
                  again; Rocky reconciles it on your next submit.
                </p>
              )}
              {preview.inFlight === null && preview.latestSubmission?.status === "posted" && (
                <p className="finish-muted">
                  You already posted a review from Rocky ({attemptText(preview.latestSubmission)},{" "}
                  {timeAgo(preview.latestSubmission.createdAt, now)}). Its comments are not listed
                  again; submitting now posts a second review.
                </p>
              )}
              {preview.inFlight === null && preview.latestSubmission?.status === "failed" && (
                <p className="finish-muted">
                  Your last attempt ({attemptText(preview.latestSubmission)},{" "}
                  {timeAgo(preview.latestSubmission.createdAt, now)}) did not post
                  {preview.latestSubmission.errorCode === null
                    ? ""
                    : ` (${preview.latestSubmission.errorCode})`}
                  ; its comments are listed again.
                </p>
              )}
              {items.length === 0 ? (
                <p className="finish-muted">No inline comments.</p>
              ) : (
                <ol className="post-list">
                  {items.map((item) => (
                    <li key={item.id} data-item-kind={item.kind}>
                      <div className="post-meta">
                        <bdi className="post-loc">{itemLocation(item)}</bdi>
                        <span className="post-kind">
                          · {item.kind === "draft" ? "from AI draft" : "your comment"}
                        </span>
                      </div>
                      <pre className="post-raw">
                        <bdi>{item.body}</bdi>
                      </pre>
                    </li>
                  ))}
                </ol>
              )}
              {items.length > 0 && (
                <p className="finish-fine">
                  Each comment is shown exactly as GitHub will receive it (Markdown source), under
                  your name.
                </p>
              )}
            </>
          )}
        </section>

        <div className="modal-section finish-summary">
          <label className="sr-only" htmlFor="finish-summary">
            Overall comment (optional)
          </label>
          <textarea
            id="finish-summary"
            rows={3}
            placeholder="Overall comment (optional)"
            maxLength={65_536}
            value={summary}
            disabled={sending}
            onChange={(e) => setSummary(e.target.value)}
          />
          <div className="finish-summary-actions">
            <button
              type="button"
              className="btn btn-sm btn-ai"
              disabled={items.length === 0 || sending}
              onClick={draft}
            >
              <span className="mark" aria-hidden="true">
                ✦
              </span>{" "}
              {summary !== "" && summary !== drafted
                ? "Replace with a draft from my comments"
                : "Draft a summary from my comments"}
            </button>
            {drafted !== null && summary === drafted && (
              <span className="finish-fine" role="status">
                A suggestion from your comments: edit it, or clear it.
              </span>
            )}
          </div>
        </div>

        <fieldset className="modal-section verdict-opts" disabled={sending}>
          <legend className="sr-only">Verdict</legend>
          {VERDICTS.map((v) => {
            const suggested = suggestion?.verdict === v;
            return (
              <label key={v} className={suggested ? "suggested" : undefined}>
                <input
                  type="radio"
                  name="verdict"
                  value={v}
                  checked={verdict === v}
                  onChange={() => {
                    setPicked(true);
                    setVerdict(v);
                  }}
                />
                <span>
                  <b>{VERDICT_LABEL[v]}</b>
                  {suggested && <span className="suggested-tag">Suggested</span>}
                  <small>{suggested ? suggestion.reason : VERDICT_HINT[v]}</small>
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="modal-foot">
          {blocked !== null && (
            <span className="finish-blocked" role="status">
              {blocked}
            </span>
          )}
          <button type="button" className="btn" disabled={sending} onClick={close}>
            Keep reviewing
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canSubmit}
            // Focusable while arming (Tab order stays stable), but inert.
            aria-disabled={!armed || !canSubmit}
            data-armed={armed}
            onClick={() => void submit()}
          >
            {sending ? "Submitting…" : "Submit review"}
          </button>
        </div>
      </div>
    </div>
  );
};
