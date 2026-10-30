/**
 * The inbox (P6-7): open pull requests across the org's repositories, riskiest first, with
 * filters, and the group Rocky offers for bulk approval. The group is a suggestion: nothing is
 * selected until the person ticks it, and nothing is approved until they confirm the exact batch
 * in the dialog (`ApproveDialog`), one request per confirmation.
 *
 * Every PR string is a React text child in a <bdi> (React escapes it; bidi controls in it cannot
 * reorder the text around it). Links are built from validated names (`reviewHref`).
 */
import {
  groupInbox,
  type InboxFilter,
  type InboxItem,
  type InboxRisk,
  matchesFilter,
  NO_FILTER,
  repoKey,
} from "@rocky-reviews/core";
import { useId, useMemo, useState } from "react";
import { timeAgo } from "../lib/time.js";
import type { Mode } from "../theme.js";
import { ApproveDialog } from "./ApproveDialog.js";
import {
  ANALYSIS_LABEL,
  findingTotal,
  notOfferedBecause,
  plural,
  reviewHref,
  RISK_LABEL,
  RISK_OPTIONS,
} from "./inbox-model.js";
import type { InboxSource } from "./inbox-source.js";

type Props = {
  items: readonly InboxItem[];
  now: number;
  mode: Mode;
  onToggleMode: () => void;
  source: InboxSource;
  /** Asks the page to load the inbox again (after a refused batch). */
  onReload: () => void;
};

export const Inbox = ({ items: loaded, now, mode, onToggleMode, source, onReload }: Props) => {
  const [filter, setFilter] = useState<InboxFilter>(NO_FILTER);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [approved, setApproved] = useState<ReadonlySet<string>>(() => new Set());
  const [batch, setBatch] = useState<readonly InboxItem[] | null>(null);
  const [status, setStatus] = useState("");

  const items = useMemo(() => loaded.filter((i) => !approved.has(i.id)), [loaded, approved]);
  const repos = useMemo(() => [...new Set(items.map(repoKey))].toSorted(), [items]);
  const shown = useMemo(() => items.filter((i) => matchesFilter(i, filter)), [items, filter]);
  const groups = useMemo(() => groupInbox(shown), [shown]);
  /** The batch is what is selected and still shown: a filter never approves something hidden. */
  const picked = groups.safe.filter((i) => selected.has(i.id));
  const filtered = isFiltered(filter);
  const nextMode = mode === "dark" ? "light" : "dark";

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const allPicked = groups.safe.length > 0 && picked.length === groups.safe.length;
  const selectAll = () =>
    setSelected((current) => {
      const next = new Set(current);
      for (const item of groups.safe) {
        if (allPicked) next.delete(item.id);
        else next.add(item.id);
      }
      return next;
    });

  const closeDialog = (outcome: { approved: readonly string[]; refused: boolean } | null) => {
    setBatch(null);
    if (outcome === null) return;
    if (outcome.approved.length > 0) {
      setApproved((current) => new Set([...current, ...outcome.approved]));
      setSelected(
        (current) => new Set([...current].filter((id) => !outcome.approved.includes(id))),
      );
      setStatus(`Approved ${plural(outcome.approved.length, "pull request", "pull requests")}.`);
      // The opener is gone or disabled now, so the dialog cannot hand focus back to it: keep the
      // keyboard where the batch was.
      window.requestAnimationFrame(() => document.getElementById("safe-title")?.focus());
    }
    if (outcome.refused) onReload();
  };

  return (
    <div className="inbox-app">
      <div className="topbar-wrap">
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true" />
            <span className="hide-sm">Rocky Reviews</span>
          </div>
          <div className="inbox-head">
            <h1 id="inbox-title" className="inbox-title">
              Inbox
            </h1>
            <span className="inbox-sub">
              {plural(items.length, "open pull request", "open pull requests")} in{" "}
              {plural(repos.length, "repository", "repositories")}
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
      <main id="main" className="inbox-main" tabIndex={-1}>
        <Filters filter={filter} repos={repos} onChange={setFilter} />
        <div className="inbox-counts">
          <p aria-live="polite">{filtered ? `Showing ${shown.length} of ${items.length}` : ""}</p>
          <p role="status" className="inbox-status">
            {status}
          </p>
        </div>

        <section className="card inbox-group inbox-safe" aria-labelledby="safe-title">
          <div className="inbox-group-head">
            <h2 id="safe-title" tabIndex={-1}>
              <span className="ai-tag">Safe to bulk-approve</span>{" "}
              <span className="inbox-count">{groups.safe.length}</span>
            </h2>
            {groups.safe.length > 0 && (
              <button type="button" className="btn btn-sm" onClick={selectAll}>
                {allPicked ? "Clear selection" : `Select all ${groups.safe.length}`}
              </button>
            )}
          </div>
          <p className="inbox-note">
            Low risk, no AI findings, no auth or migration files, small, and analysed at the current
            commit. Rocky suggests these; nothing is approved until you confirm a batch.
          </p>
          {groups.safe.length === 0 ? (
            <p className="inbox-empty">
              {filtered && items.some((i) => i.bulkApproval.eligible)
                ? "No pull request here matches the filters."
                : "Nothing to bulk-approve right now."}
            </p>
          ) : (
            <>
              <ul className="inbox-list">
                {groups.safe.map((item) => (
                  <Row
                    key={item.id}
                    item={item}
                    now={now}
                    select={{ checked: selected.has(item.id), onToggle: () => toggle(item.id) }}
                  />
                ))}
              </ul>
              <div className="inbox-group-foot">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={picked.length === 0}
                  onClick={() => setBatch(picked)}
                >
                  {picked.length === 0 ? "Approve selected…" : `Approve ${picked.length} selected…`}
                </button>
              </div>
            </>
          )}
        </section>

        <section className="card inbox-group" aria-labelledby="review-title">
          <div className="inbox-group-head">
            <h2 id="review-title">
              Needs your review <span className="inbox-count">{groups.review.length}</span>
            </h2>
          </div>
          {groups.review.length === 0 ? (
            <p className="inbox-empty">
              {filtered && items.some((i) => !i.bulkApproval.eligible)
                ? "No pull request here matches the filters."
                : "Nothing waiting for your review."}
            </p>
          ) : (
            <ol className="inbox-list">
              {groups.review.map((item) => (
                <Row key={item.id} item={item} now={now} />
              ))}
            </ol>
          )}
        </section>
      </main>
      {batch !== null && <ApproveDialog batch={batch} source={source} onClose={closeDialog} />}
    </div>
  );
};

const isFiltered = (filter: InboxFilter): boolean =>
  filter.repo !== null || filter.risk !== null || filter.query.trim() !== "";

const Filters = ({
  filter,
  repos,
  onChange,
}: {
  filter: InboxFilter;
  repos: readonly string[];
  onChange: (filter: InboxFilter) => void;
}) => {
  const id = useId();
  return (
    <form className="inbox-filters" role="search" onSubmit={(e) => e.preventDefault()}>
      <label className="inbox-field" htmlFor={`${id}-repo`}>
        <span>Repository</span>
        <select
          id={`${id}-repo`}
          value={filter.repo ?? ""}
          onChange={(e) => onChange({ ...filter, repo: e.target.value || null })}
        >
          <option value="">All repositories</option>
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
      </label>
      <label className="inbox-field" htmlFor={`${id}-risk`}>
        <span>Risk</span>
        <select
          id={`${id}-risk`}
          value={filter.risk ?? ""}
          onChange={(e) =>
            onChange({ ...filter, risk: (e.target.value || null) as InboxRisk | null })
          }
        >
          <option value="">All risks</option>
          {RISK_OPTIONS.map((risk) => (
            <option key={risk} value={risk}>
              {RISK_LABEL[risk]}
            </option>
          ))}
        </select>
      </label>
      <label className="inbox-field inbox-search" htmlFor={`${id}-q`}>
        <span>Search</span>
        <input
          id={`${id}-q`}
          type="search"
          placeholder="Title, repository or #number"
          value={filter.query}
          onChange={(e) => onChange({ ...filter, query: e.target.value })}
        />
      </label>
      {isFiltered(filter) && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(NO_FILTER)}>
          Clear filters
        </button>
      )}
    </form>
  );
};

const Row = ({
  item,
  now,
  select,
}: {
  item: InboxItem;
  now: number;
  select?: { checked: boolean; onToggle: () => void };
}) => {
  const findings = findingTotal(item);
  const why = notOfferedBecause(item);
  return (
    <li className={`inbox-row risk-${item.risk}`} data-number={item.number}>
      {select !== undefined && (
        <input
          type="checkbox"
          className="check inbox-check"
          checked={select.checked}
          onChange={select.onToggle}
          aria-label={`Select ${repoKey(item)} #${item.number}: ${item.title}`}
        />
      )}
      <span className="risk-pill">{RISK_LABEL[item.risk]}</span>
      <div className="inbox-row-main">
        <a className="inbox-row-title" href={reviewHref(item)}>
          <bdi>{item.title}</bdi>
        </a>
        <div className="inbox-row-meta">
          <span>
            <bdi>{repoKey(item)}</bdi> #{item.number}
          </span>
          <span>{item.author === null ? "Someone" : <bdi>@{item.author}</bdi>}</span>
          {item.size !== null && (
            <span>
              <span className="add">+{item.size.additions}</span>{" "}
              <span className="del">−{item.size.deletions}</span>
            </span>
          )}
          <span>updated {timeAgo(item.updatedAt, now)}</span>
        </div>
      </div>
      <div className="inbox-row-side">
        {findings > 0 && (
          <span className="inbox-findings">
            <span className="dots" aria-hidden="true">
              {(["critical", "high", "medium", "low"] as const).flatMap((severity) =>
                Array.from({ length: Math.min(item.findings[severity], 5) }, (_, i) => (
                  <span key={`${severity}-${i}`} className={`dot ${severity}`} />
                )),
              )}
            </span>
            <span className="sr-only">
              {plural(findings, "AI finding", "AI findings")}:{" "}
              {(["critical", "high", "medium", "low"] as const)
                .filter((s) => item.findings[s] > 0)
                .map((s) => `${item.findings[s]} ${s}`)
                .join(", ")}
            </span>
          </span>
        )}
        {item.estimatedMinutes !== null && item.analysis !== "out_of_date" && (
          <span className="inbox-minutes">~{item.estimatedMinutes} min</span>
        )}
        {item.analysis !== "done" && (
          <span className="inbox-note-pill">{ANALYSIS_LABEL[item.analysis]}</span>
        )}
        {why !== null && <span className="inbox-note-pill">{why}</span>}
      </div>
    </li>
  );
};
