/**
 * The per-batch confirmation (P6-7): a modal dialog listing exactly the pull requests and the
 * commits the approval is pinned to. Only its confirm button calls `source.approve`, once: the
 * button ignores activation for `ARM_MS` after the dialog opens (so the second click of a
 * double-click on the opener, which can land where the confirm button appears, does nothing),
 * it is disabled while the request runs, a ref guards against a second call in the same
 * frame, and the dialog cannot be dismissed until the answer is in (Escape is cancelled, and a
 * close the browser forces anyway, e.g. Chrome's close watcher on a second Escape, reopens it).
 * While sending, focus sits on a live "Approving…" status inside the dialog. Cancel (focused
 * first) and Escape close it without sending anything.
 */
import type { InboxItem } from "@rocky-reviews/core";
import { useEffect, useRef, useState } from "react";
import { plural, REFUSAL_LABEL, shortSha } from "./inbox-model.js";
import type { ApproveResult, InboxSource } from "./inbox-source.js";

type Phase = { kind: "confirm" } | { kind: "sending" } | { kind: "result"; result: ApproveResult };

type Props = {
  batch: readonly InboxItem[];
  source: InboxSource;
  /**
   * `null`: closed without sending. Otherwise the approved ids, and whether the inbox must be
   * loaded again (refused, an unclear answer, or a PR not approved): a selection kept from a
   * stale list must not be confirmed again as if nothing happened.
   */
  onClose: (outcome: { approved: readonly string[]; reload: boolean } | null) => void;
};

const Name = ({ item }: { item: InboxItem }) => (
  <>
    <bdi>
      {item.repo.owner}/{item.repo.name}
    </bdi>{" "}
    #{item.number}
  </>
);

/** How long the confirm button stays inert after the dialog opens. */
export const ARM_MS = 600;

export const ApproveDialog = ({ batch, source, onClose }: Props) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const sent = useRef(false);
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const phaseRef = useRef<Phase["kind"]>("confirm");
  phaseRef.current = phase.kind;
  /** Set when this component closes the dialog itself. */
  const closing = useRef(false);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setArmed(true), ARM_MS);
    return () => window.clearTimeout(timer);
  }, []);
  const count = plural(batch.length, "pull request", "pull requests");

  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    // The safe choice first: Cancel.
    element?.querySelector<HTMLElement>("[data-cancel]")?.focus();
  }, []);

  // Sending disables the buttons: keep focus in the dialog, on the live status. The result
  // replaces the buttons: move focus to Close.
  useEffect(() => {
    const target =
      phase.kind === "sending" ? "[data-sending]" : phase.kind === "result" ? "[data-close]" : null;
    if (target !== null) dialog.current?.querySelector<HTMLElement>(target)?.focus();
  }, [phase.kind]);

  const outcome = () => {
    if (phase.kind !== "result") return null;
    const { result } = phase;
    return {
      approved:
        result.kind === "done"
          ? result.results.filter((r) => r.outcome === "approved").map((r) => r.id)
          : [],
      reload: result.kind !== "done" || result.results.some((r) => r.outcome !== "approved"),
    };
  };

  const close = () => {
    if (phase.kind === "sending") return;
    closing.current = true;
    dialog.current?.close();
    onClose(outcome());
  };

  /** The browser closed the dialog without us (a forced Escape). */
  const closedByBrowser = () => {
    if (closing.current) return;
    if (phaseRef.current === "sending") {
      dialog.current?.showModal();
      dialog.current?.querySelector<HTMLElement>("[data-sending]")?.focus();
      return;
    }
    close();
  };

  const confirm = async () => {
    if (!armed || sent.current) return;
    sent.current = true;
    setPhase({ kind: "sending" });
    const result = await source.approve({
      pullRequests: batch.map((item) => ({ id: item.id, headSha: item.headSha })),
    });
    setPhase({ kind: "result", result });
  };

  return (
    <dialog
      ref={dialog}
      className="modal inbox-dialog"
      aria-labelledby="approve-title"
      onCancel={(event) => {
        // Escape: closes like Cancel, but never while the batch is being sent.
        event.preventDefault();
        close();
      }}
      onClose={closedByBrowser}
    >
      <h2 id="approve-title" className="modal-head">
        {phase.kind === "result" ? resultTitle(phase.result) : `Approve ${count}?`}
      </h2>
      {phase.kind === "result" ? (
        <Result result={phase.result} batch={batch} />
      ) : (
        <div className="modal-section">
          <p>
            Rocky will submit an approving review on GitHub as you on each pull request below, at
            the commit shown. If any of them has changed since, nothing is approved.
          </p>
          <ul className="batch-list">
            {batch.map((item) => (
              <li key={item.id}>
                <span className="batch-name">
                  <Name item={item} />
                </span>{" "}
                <bdi className="batch-title">{item.title}</bdi>{" "}
                <code className="batch-sha" title={item.headSha}>
                  {shortSha(item.headSha)}
                </code>
              </li>
            ))}
          </ul>
          <p className="batch-hint" role="status" tabIndex={-1} data-sending>
            {phase.kind === "sending" ? "Approving… keep this open until GitHub answers." : ""}
          </p>
        </div>
      )}
      <div className="modal-foot">
        {phase.kind === "result" ? (
          <button type="button" className="btn" data-close onClick={close}>
            Close
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn"
              data-cancel
              disabled={phase.kind === "sending"}
              onClick={close}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={phase.kind === "sending"}
              // Focusable while arming (Tab order stays stable), but inert.
              aria-disabled={!armed}
              onClick={() => void confirm()}
            >
              {phase.kind === "sending" ? "Approving…" : `Approve ${count}`}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
};

const resultTitle = (result: ApproveResult): string => {
  if (result.kind === "done") {
    return result.results.every((r) => r.outcome === "approved")
      ? "Batch approved"
      : result.results.some((r) => r.outcome === "approved")
        ? "Batch partly approved"
        : "Nothing was approved";
  }
  if (result.kind === "refused") return "Batch refused";
  return result.kind === "error" ? "Something went wrong" : "Nothing was approved";
};
const Result = ({ result, batch }: { result: ApproveResult; batch: readonly InboxItem[] }) => {
  const byId = new Map(batch.map((item) => [item.id, item]));
  if (result.kind === "unavailable") {
    return (
      <div className="modal-section">
        <p>Bulk approval is not available on this server yet. Nothing was approved.</p>
      </div>
    );
  }
  if (result.kind === "error") {
    return (
      <div className="modal-section">
        <p>
          Rocky could not confirm what happened. Reload the inbox to see where each pull request
          stands before trying again.
        </p>
      </div>
    );
  }
  if (result.kind === "refused") {
    return (
      <div className="modal-section">
        <p>Nothing was approved. These pull requests changed since the inbox loaded:</p>
        <ul className="batch-list">
          {result.refusals.map((refusal) => {
            const item = byId.get(refusal.id);
            return (
              <li key={refusal.id}>
                {item !== undefined && (
                  <span className="batch-name">
                    <Name item={item} />
                  </span>
                )}{" "}
                {REFUSAL_LABEL[refusal.reason]}
              </li>
            );
          })}
        </ul>
        <p className="batch-hint">The inbox reloads when you close this.</p>
      </div>
    );
  }
  const approved = result.results.filter((r) => r.outcome === "approved");
  const failed = result.results.filter((r) => r.outcome === "failed");
  const moved = result.results.filter((r) => r.outcome === "head_moved");
  return (
    <div className="modal-section">
      {approved.length > 0 && (
        <p>Approved {plural(approved.length, "pull request", "pull requests")} on GitHub.</p>
      )}
      {failed.length > 0 && (
        <>
          <p>{failed.length} could not be approved and stay in the inbox:</p>
          <ul className="batch-list">
            {failed.map((r) => {
              const item = byId.get(r.id);
              return (
                <li key={r.id}>
                  {item !== undefined && (
                    <>
                      <span className="batch-name">
                        <Name item={item} />
                      </span>{" "}
                      <bdi className="batch-title">{item.title}</bdi>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {moved.length > 0 && (
        <>
          <p>
            {moved.length} had new commits on GitHub since you looked and{" "}
            {moved.length === 1 ? "was" : "were"} not approved:
          </p>
          <ul className="batch-list">
            {moved.map((r) => {
              const item = byId.get(r.id);
              return (
                <li key={r.id}>
                  {item !== undefined && (
                    <span className="batch-name">
                      <Name item={item} />
                    </span>
                  )}{" "}
                  New commits since you looked
                </li>
              );
            })}
          </ul>
        </>
      )}
      {(failed.length > 0 || moved.length > 0) && (
        <p className="batch-hint">The inbox reloads when you close this.</p>
      )}
    </div>
  );
};
