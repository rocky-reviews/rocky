/**
 * The connection page's two modal dialogs (P10-4), on the inbox's confirmation pattern
 * (`ApproveDialog`): a native modal `<dialog>` (the page behind it is inert, Tab stays inside),
 * the safe choice focused first, Escape closes it unless a request is in flight, and the opener
 * gets focus back (the page does that).
 */
import type { AddRepositoryResponse, AvailableRepository } from "@rocky-reviews/core";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { addRefusalText } from "./connection-model.js";
import type { ConnectionSource } from "./connection-source.js";

const useModal = (onClose: () => void, busy: boolean) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closing = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    element?.querySelector<HTMLElement>("[data-first]")?.focus();
  }, []);
  /** Closes it whatever the state, then runs `after` (the request is done). */
  const finish = (after: () => void) => {
    closing.current = true;
    dialog.current?.close();
    after();
  };
  const close = () => {
    if (!busyRef.current) finish(onClose);
  };
  const props = {
    ref: dialog,
    onCancel: (event: { preventDefault: () => void }) => {
      event.preventDefault();
      close();
    },
    /** The browser closed it without us (a forced Escape): reopen while busy, else close. */
    onClose: () => {
      if (closing.current) return;
      if (busyRef.current) dialog.current?.showModal();
      else close();
    },
  };
  return { props, close, finish };
};

/** Asks before something that stops Rocky reading or posting. */
export const ConfirmDialog = ({
  title,
  children,
  confirmLabel,
  busyLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busyLabel: string;
  /** Resolves to the problem's text, or `null` when done (the dialog then closes). */
  onConfirm: () => Promise<string | null>;
  onClose: () => void;
}) => {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { props, close, finish } = useModal(onClose, busy);
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await onConfirm();
    setBusy(false);
    if (result === null) finish(onClose);
    else setProblem(result);
  };
  return (
    <dialog {...props} className="modal inbox-dialog" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="modal-head">
        {title}
      </h2>
      <div className="modal-section">
        {children}
        {problem !== null && (
          <p className="token-problem" role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" data-first onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => void confirm()}
          {...(busy ? { "aria-disabled": true } : {})}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </dialog>
  );
};

type Listing =
  | { kind: "loading" }
  | { kind: "ready"; repositories: readonly AvailableRepository[]; truncated: boolean }
  | { kind: "failed"; text: string };

const name = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;

/**
 * The repositories the token can see (`GET /api/connection/available`), filtered here, with
 * "Add" on those Rocky does not follow yet. Adding one closes the picker with what it read.
 */
export const RepositoryPicker = ({
  source,
  onAdded,
  onClose,
}: {
  source: ConnectionSource;
  onAdded: (added: AddRepositoryResponse) => void;
  onClose: () => void;
}) => {
  const id = useId();
  const [listing, setListing] = useState<Listing>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { props, close, finish } = useModal(onClose, adding !== null);

  useEffect(() => {
    let live = true;
    void source.available().then((answer) => {
      if (!live) return;
      if (answer.kind === "ok") setListing({ kind: "ready", ...answer.value });
      else
        setListing({
          kind: "failed",
          text:
            answer.kind === "refused"
              ? addRefusalText(answer.error, answer.retryAt)
              : "The repositories could not be listed. Try again.",
        });
    });
    return () => {
      live = false;
    };
  }, [source]);

  const shown = useMemo(() => {
    if (listing.kind !== "ready") return [];
    const q = query.trim().toLowerCase();
    return q === ""
      ? listing.repositories
      : listing.repositories.filter((r) => name(r).toLowerCase().includes(q));
  }, [listing, query]);

  const add = async (repo: AvailableRepository) => {
    if (adding !== null) return;
    setAdding(repo.forgeRepoId);
    setProblem(null);
    const answer = await source.addRepository(repo.forgeRepoId);
    setAdding(null);
    if (answer.kind === "ok") {
      const added = answer.value;
      finish(() => onAdded(added));
      return;
    }
    setProblem(
      answer.kind === "refused"
        ? addRefusalText(answer.error, answer.retryAt)
        : "The repository could not be added. Try again.",
    );
  };

  return (
    <dialog {...props} className="modal inbox-dialog picker-dialog" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="modal-head">
        Add a repository
      </h2>
      <div className="modal-section">
        <label className="token-field" htmlFor={`${id}-filter`}>
          <span>Filter</span>
          <input
            id={`${id}-filter`}
            type="search"
            data-first
            value={query}
            placeholder="owner/name"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {listing.kind === "loading" ? (
          <p role="status" className="picker-note">
            Asking GitHub which repositories the token can see…
          </p>
        ) : listing.kind === "failed" ? (
          <p role="alert" className="token-problem">
            {listing.text}
          </p>
        ) : (
          <>
            <p className="picker-note" aria-live="polite">
              {shown.length === listing.repositories.length
                ? `${listing.repositories.length}\u00a0repositories this token can see`
                : `Showing ${shown.length} of ${listing.repositories.length}`}
            </p>
            {listing.truncated && (
              <p className="picker-note">Showing the first 500 repositories this token can see.</p>
            )}
            {shown.length === 0 ? (
              <p className="picker-note">No repository matches.</p>
            ) : (
              <ul className="picker-list">
                {shown.map((repo) => (
                  <li key={repo.forgeRepoId} className="picker-row">
                    <span className="picker-name">
                      <bdi>{name(repo)}</bdi>
                      {repo.private && <span className="status-pill tone-low">Private</span>}
                    </span>
                    {repo.added ? (
                      <span className="picker-added">Following</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        aria-label={`Add ${name(repo)}`}
                        onClick={() => void add(repo)}
                        {...(adding !== null ? { "aria-disabled": true } : {})}
                      >
                        {adding === repo.forgeRepoId ? "Adding…" : "Add"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {problem !== null && (
          <p className="token-problem" role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={close} disabled={adding !== null}>
          Close
        </button>
      </div>
    </dialog>
  );
};
