/**
 * The project memory page (P8-3, ADR 0039): what Rocky remembers about one repository, with the
 * evidence each entry rests on, and the controls an admin has over it: edit (a new version that
 * keeps the old one as history), switch off, delete (with its earlier versions), switch memory
 * off for the repository, and export `.rocky/context.md` as a download.
 *
 * The server decides who may change what (`memory.edit`); `canEdit` only hides controls the
 * server would refuse. Every entry string is a React text child in a <bdi> (React escapes it;
 * bidi controls cannot reorder the text around it). Links are built from validated names.
 */
import type { MemoryEdit, MemoryEntryView, MemoryListResponse } from "@rocky-reviews/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { pullRequestUrl } from "../lib/github-url.js";
import { timeAgo } from "../lib/time.js";
import { BrandMark } from "../shell/BrandMark.js";
import type { Mode } from "../theme.js";
import {
  authorLabel,
  counts,
  coversLabel,
  earlierVersions,
  KIND_LABEL,
  KIND_PLURAL,
  KINDS,
  linesLabel,
  NO_MEMORY_FILTER,
  plural,
  REASON_LABEL,
  REASONS,
  shortSha,
  visibleEntries,
  type DismissReason,
  type MemoryFilter,
  type MemoryKind,
} from "./memory-model.js";
import type { MemoryChange, MemoryRepoRef, MemorySource } from "./memory-source.js";

type Props = {
  data: MemoryListResponse;
  now: number;
  mode: Mode;
  onToggleMode: () => void;
  source: MemorySource;
  repo: MemoryRepoRef;
  /** Loads the list again (after a change); resolves once the new list is shown. */
  onReload: () => Promise<void>;
};

const CHANGE_PROBLEM: Readonly<Record<Exclude<MemoryChange["kind"], "ok">, string>> = {
  invalid_text:
    "Rocky can't store that text: one line of at most 300 characters, without links or hidden characters.",
  conflict: "Someone changed this entry first. The list now shows the latest version.",
  forbidden: "Only admins and owners can change project memory.",
  not_found: "This entry no longer exists. The list now shows what is left.",
  error: "That didn't work. Try again.",
};

export const MAX_TEXT = 300;

export const Memory = ({ data, now, mode, onToggleMode, source, repo, onReload }: Props) => {
  const [filter, setFilter] = useState<MemoryFilter>(NO_MEMORY_FILTER);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MemoryEntryView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The live message after a change; `quiet` when the page already shows it (the off banner). */
  const [status, setStatus] = useState({ text: "", quiet: false });
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const nextMode = mode === "dark" ? "light" : "dark";
  const fullName = `${data.repository.owner}/${data.repository.name}`;
  const shown = useMemo(() => visibleEntries(data.entries, filter), [data.entries, filter]);
  const total = counts(data.entries);

  /** Runs one change; on success reloads, says `done` and moves focus to `focus` (an id). */
  const run = async (
    key: string,
    change: () => Promise<MemoryChange>,
    done: string,
    focus?: string,
    quiet = false,
  ): Promise<boolean> => {
    if (busy !== null) return false;
    setBusy(key);
    setProblem(null);
    setStatus({ text: "", quiet: false });
    const result = await change();
    if (result.kind === "ok" || result.kind === "conflict" || result.kind === "not_found")
      await onReload();
    setBusy(null);
    if (result.kind !== "ok") {
      setProblem({ id: key, text: CHANGE_PROBLEM[result.kind] });
      return false;
    }
    setStatus({ text: done, quiet });
    if (focus !== undefined)
      window.requestAnimationFrame(() => document.getElementById(focus)?.focus());
    return true;
  };

  const switchRepo = (enabled: boolean) =>
    run(
      "repo",
      () => source.setEnabled(repo, enabled),
      enabled
        ? "Memory is on: reviews use these entries again."
        : "Memory is off: reviews use none of these entries.",
      undefined,
      // Switched off, the banner says it on screen; the message is for screen readers only.
      !enabled,
    );

  return (
    <div className="inbox-app memory-app">
      <div className="topbar-wrap">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <header className="topbar">
          <a className="brand brand-link" href="/inbox" aria-label="Rocky Reviews, go to the inbox">
            <BrandMark />
            <span className="hide-sm">Rocky Reviews</span>
          </a>
          <div className="inbox-head">
            <h1 id="memory-page-title" className="inbox-title">
              Project memory
            </h1>
            <span className="inbox-sub">
              <bdi>{fullName}</bdi> · {plural(total.current, "entry", "entries")}
              {total.off > 0 ? ` · ${total.off} switched off` : ""}
            </span>
          </div>
          <button
            type="button"
            className="mode-btn"
            aria-label={`Switch to ${nextMode} mode`}
            title={`Switch to ${nextMode} mode`}
            onClick={onToggleMode}
          >
            <span aria-hidden="true">{mode === "dark" ? "☀" : "☾"}</span>
          </button>
        </header>
      </div>
      <main id="main" className="inbox-main memory-main" tabIndex={-1}>
        <section className="card memory-intro" aria-labelledby="memory-intro-title">
          <h2 id="memory-intro-title" className="memory-intro-title">
            What Rocky remembers about <bdi>{fullName}</bdi>
          </h2>
          <p className="memory-note">
            Conventions, decisions and dismissals from this repository&rsquo;s reviews. Rocky gives
            them to its reviews of files near their evidence, as data, and cites the ones a finding
            relies on. Names, logins and emails are removed from an entry&rsquo;s text before it is
            stored.
          </p>
          <div className="memory-controls">
            {data.canEdit ? (
              <label className="memory-switch">
                <input
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={data.repository.memoryEnabled}
                  disabled={busy !== null}
                  onChange={(e) => void switchRepo(e.target.checked)}
                />
                <span>Use project memory in reviews of this repository</span>
              </label>
            ) : (
              <p className="memory-switch-text">
                Project memory is <b>{data.repository.memoryEnabled ? "on" : "off"}</b> for reviews
                of this repository. Only admins and owners can change it.
              </p>
            )}
            <a
              className="btn"
              href={source.exportHref(repo)}
              download="context.md"
              aria-describedby="memory-export-hint"
            >
              <span aria-hidden="true">↓</span> Export context.md
            </a>
          </div>
          <p id="memory-export-hint" className="memory-hint">
            Downloads the current entries as <code>.rocky/context.md</code> for you to commit. Rocky
            never writes to your repository. The file holds no names or logins.
          </p>
          {problem?.id === "repo" && (
            <p className="memory-problem" role="alert">
              {problem.text}
            </p>
          )}
          {!data.repository.memoryEnabled && (
            <p className="memory-off-banner">
              <b>Memory is off.</b> Reviews of this repository use none of these entries, and Rocky
              learns nothing new from posted reviews until it is switched back on.
            </p>
          )}
        </section>

        {data.entries.length > 0 && <Filters filter={filter} data={data} onChange={setFilter} />}
        <p role="status" className={`inbox-status memory-status${status.quiet ? " sr-only" : ""}`}>
          {status.text}
        </p>

        <section className="card inbox-group" aria-labelledby="memory-list-title">
          <div className="inbox-group-head">
            <h2 id="memory-list-title" tabIndex={-1}>
              {filter.kind === null ? "Entries" : KIND_PLURAL[filter.kind]}{" "}
              <span className="inbox-count">
                {shown.filter((e) => e.supersededBy === null).length}
                {filter.history && shown.some((e) => e.supersededBy !== null)
                  ? ` + ${shown.filter((e) => e.supersededBy !== null).length} earlier`
                  : ""}
              </span>
            </h2>
          </div>
          {data.truncated && (
            <p className="inbox-note">Showing the newest {data.entries.length} entries.</p>
          )}
          {shown.length === 0 ? (
            <p className="inbox-empty">
              {data.entries.length === 0
                ? "Rocky hasn't learned anything about this repository yet. It learns from the reviews you post: what you dismiss, and the findings you accept."
                : "No entry matches the filter."}
            </p>
          ) : (
            <ul className="memory-list">
              {shown.map((entry) => (
                <Entry
                  key={entry.id}
                  entry={entry}
                  repo={repo}
                  now={now}
                  canEdit={data.canEdit}
                  editing={editing === entry.id}
                  busy={busy}
                  problem={problem?.id === entry.id ? problem.text : null}
                  onEdit={() => {
                    setProblem(null);
                    setEditing(entry.id);
                  }}
                  onCancelEdit={() => {
                    setEditing(null);
                    window.requestAnimationFrame(() =>
                      document.getElementById(`edit-${entry.id}`)?.focus(),
                    );
                  }}
                  onSave={async (edit) => {
                    const ok = await run(
                      entry.id,
                      () => source.edit(repo, entry.id, edit),
                      "Saved. The earlier version is kept as history.",
                      "memory-list-title",
                    );
                    if (ok) setEditing(null);
                  }}
                  onSwitch={() =>
                    void run(
                      entry.id,
                      () => source.setDisabled(repo, entry.id, entry.disabledAt === null),
                      entry.disabledAt === null
                        ? "Switched off: reviews no longer use this entry."
                        : "Switched on: reviews use this entry again.",
                    )
                  }
                  onDelete={() => setDeleting(entry)}
                />
              ))}
            </ul>
          )}
        </section>
      </main>
      {deleting !== null && (
        <DeleteDialog
          entry={deleting}
          earlier={earlierVersions(data.entries, deleting.id)}
          busy={busy === deleting.id}
          onCancel={() => {
            const id = deleting.id;
            setDeleting(null);
            window.requestAnimationFrame(() => document.getElementById(`delete-${id}`)?.focus());
          }}
          onConfirm={async () => {
            const earlier = earlierVersions(data.entries, deleting.id);
            await run(
              deleting.id,
              () => source.remove(repo, deleting.id),
              earlier === 0
                ? "Deleted."
                : `Deleted, with ${plural(earlier, "earlier version", "earlier versions")}.`,
              "memory-list-title",
            );
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
};

const Filters = ({
  filter,
  data,
  onChange,
}: {
  filter: MemoryFilter;
  data: MemoryListResponse;
  onChange: (filter: MemoryFilter) => void;
}) => {
  const id = useId();
  const current = data.entries.filter((e) => e.supersededBy === null);
  const history = data.entries.length - current.length;
  return (
    <form className="inbox-filters" role="search" onSubmit={(e) => e.preventDefault()}>
      <label className="inbox-field" htmlFor={`${id}-kind`}>
        <span>Kind</span>
        <select
          id={`${id}-kind`}
          value={filter.kind ?? ""}
          onChange={(e) =>
            onChange({ ...filter, kind: (e.target.value || null) as MemoryKind | null })
          }
        >
          <option value="">All kinds</option>
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_PLURAL[kind]} ({current.filter((e) => e.kind === kind).length})
            </option>
          ))}
        </select>
      </label>
      <label className="memory-history">
        <input
          type="checkbox"
          className="check"
          checked={filter.history}
          onChange={(e) => onChange({ ...filter, history: e.target.checked })}
        />
        <span>Show earlier versions ({history})</span>
      </label>
    </form>
  );
};

type EntryProps = {
  entry: MemoryEntryView;
  repo: MemoryRepoRef;
  now: number;
  canEdit: boolean;
  editing: boolean;
  busy: string | null;
  problem: string | null;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (edit: MemoryEdit) => Promise<void>;
  onSwitch: () => void;
  onDelete: () => void;
};

const Entry = ({
  entry,
  repo,
  now,
  canEdit,
  editing,
  busy,
  problem,
  onEdit,
  onCancelEdit,
  onSave,
  onSwitch,
  onDelete,
}: EntryProps) => {
  const textId = `text-${entry.id}`;
  const current = entry.supersededBy === null;
  const off = entry.disabledAt !== null;
  const covers = coversLabel(entry);
  const prUrl = pullRequestUrl({
    owner: repo.owner,
    repo: repo.repo,
    number: entry.evidence.pullRequestNumber,
  });
  const locked = busy !== null;
  return (
    <li
      className={`memory-entry kind-${entry.kind} origin-${entry.origin}${off ? " is-off" : ""}${current ? "" : " is-history"}`}
      data-entry={entry.id}
    >
      <div className="memory-entry-head">
        <span className="memory-kind">
          <span className="ic memory" aria-hidden="true" />
          {KIND_LABEL[entry.kind]}
        </span>
        {entry.reason !== null && (
          <span className="memory-reason">
            {REASON_LABEL[entry.reason]}
            {covers === null ? "" : ` · ${covers}`}
          </span>
        )}
        {entry.origin === "learned" ? (
          <span className="ai-tag memory-origin">Learned from a review</span>
        ) : (
          <span className="memory-origin">Written by a member</span>
        )}
        {off && <span className="memory-state">Switched off</span>}
        {!current && <span className="memory-state">Earlier version</span>}
      </div>
      {editing ? (
        <EditForm
          entry={entry}
          busy={locked}
          problem={problem}
          onCancel={onCancelEdit}
          onSave={onSave}
        />
      ) : (
        <p className="memory-text" id={textId}>
          <bdi>{entry.text}</bdi>
        </p>
      )}
      <dl className="memory-meta">
        <div>
          <dt>Evidence</dt>
          <dd>
            <bdi className="file-path memory-path">{entry.evidence.path}</bdi>,{" "}
            {linesLabel(entry.evidence.range)} at{" "}
            <code className="memory-sha" title={entry.evidence.sha}>
              {shortSha(entry.evidence.sha)}
            </code>
          </dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {prUrl === undefined ? (
              `PR #${entry.evidence.pullRequestNumber}`
            ) : (
              <a href={prUrl} target="_blank" rel="noreferrer noopener">
                PR #{entry.evidence.pullRequestNumber}
                <span className="sr-only"> on GitHub (opens in a new tab)</span>
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{entry.confidence}%</dd>
        </div>
        <div>
          <dt>Last used</dt>
          <dd>{entry.lastUsedAt === null ? "never" : timeAgo(entry.lastUsedAt, now)}</dd>
        </div>
        <div>
          <dt>Taught by</dt>
          <dd>
            {entry.author.kind === "member" ? <bdi>{authorLabel(entry)}</bdi> : authorLabel(entry)}
          </dd>
        </div>
      </dl>
      {problem !== null && !editing && (
        <p className="memory-problem" role="alert">
          {problem}
        </p>
      )}
      {canEdit && current && !editing && (
        <div className="memory-actions">
          <button
            type="button"
            id={`edit-${entry.id}`}
            className="btn btn-sm"
            aria-describedby={textId}
            disabled={locked}
            onClick={onEdit}
          >
            Edit
          </button>
          <button
            type="button"
            className="btn btn-sm"
            aria-describedby={textId}
            aria-pressed={off}
            disabled={locked}
            onClick={onSwitch}
          >
            {off ? "Switch on" : "Switch off"}
          </button>
          <button
            type="button"
            id={`delete-${entry.id}`}
            className="btn btn-sm btn-danger-ghost"
            aria-describedby={textId}
            disabled={locked}
            onClick={onDelete}
          >
            Delete…
          </button>
        </div>
      )}
    </li>
  );
};

const EditForm = ({
  entry,
  busy,
  problem,
  onCancel,
  onSave,
}: {
  entry: MemoryEntryView;
  busy: boolean;
  problem: string | null;
  onCancel: () => void;
  onSave: (edit: MemoryEdit) => Promise<void>;
}) => {
  const id = useId();
  const [kind, setKind] = useState<MemoryKind>(entry.kind);
  const [reason, setReason] = useState<DismissReason>(entry.reason ?? "intentional");
  const [text, setText] = useState(entry.text);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  const trimmed = text.trim();
  return (
    <form
      className="memory-edit"
      aria-label="Edit entry"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || trimmed.length === 0) return;
        void onSave({ kind, text: trimmed, reason: kind === "dismissal" ? reason : null });
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="memory-edit-row">
        <label className="inbox-field" htmlFor={`${id}-kind`}>
          <span>Kind</span>
          <select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as MemoryKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        {kind === "dismissal" && (
          <label className="inbox-field" htmlFor={`${id}-reason`}>
            <span>Reason</span>
            <select
              id={`${id}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value as DismissReason)}
            >
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <label className="inbox-field memory-edit-text" htmlFor={`${id}-text`}>
        <span>Text</span>
        <textarea
          id={`${id}-text`}
          ref={area}
          value={text}
          maxLength={MAX_TEXT}
          rows={2}
          aria-describedby={`${id}-help`}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p id={`${id}-help`} className="memory-hint">
        One line, up to {MAX_TEXT} characters ({MAX_TEXT - text.length} left). Saving keeps this
        version as history; the evidence stays the same.
      </p>
      {problem !== null && (
        <p className="memory-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="memory-actions">
        <button
          type="submit"
          className="btn btn-sm btn-primary"
          disabled={busy || trimmed.length === 0}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};

const DeleteDialog = ({
  entry,
  earlier,
  busy,
  onCancel,
  onConfirm,
}: {
  entry: MemoryEntryView;
  earlier: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element !== null && !element.open) element.showModal();
    // The safe choice first: Cancel.
    element?.querySelector<HTMLElement>("[data-cancel]")?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal inbox-dialog memory-dialog"
      aria-labelledby="memory-delete-title"
      aria-describedby="memory-delete-what"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <h2 className="modal-head" id="memory-delete-title">
        Delete this {KIND_LABEL[entry.kind].toLowerCase()}?
      </h2>
      <div className="modal-section" id="memory-delete-what">
        <blockquote className="memory-quote">
          <bdi>{entry.text}</bdi>
        </blockquote>
        <p>
          Reviews stop using it, and it can&rsquo;t be brought back.
          {earlier > 0 &&
            ` Its ${plural(earlier, "earlier version is", "earlier versions are")} deleted with it.`}
        </p>
        <p className="batch-hint">
          To keep it but stop reviews from using it, switch it off instead.
        </p>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" data-cancel disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={busy}
          onClick={() => void onConfirm()}
        >
          {busy ? "Deleting…" : "Delete entry"}
        </button>
      </div>
    </dialog>
  );
};
