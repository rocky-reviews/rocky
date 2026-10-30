/**
 * One AI draft under its line in the diff (P6-4, POC `renderFinding`):
 *
 * - undecided: "✦ AI draft", severity, confidence, "Only you can see this until you accept it",
 *   title, body, suggested change, project-memory evidence, and Accept / Edit / Dismiss /
 *   Send to agent;
 * - editing: the body in a textarea, "Save as my comment" (⌘/Ctrl+Enter) or Cancel (Escape);
 * - dismissing: the four reasons or Cancel (Escape);
 * - accepted: the reviewer's pending comment, "from AI draft" or "edited from AI draft", Undo;
 * - dismissed: one collapsed line with the reason, Undo.
 *
 * After a decision focus moves to the control that undoes it (and back to Accept after an undo),
 * so the keyboard path never drops to the page. Every string is text: the finding is model
 * output about PR content, the edit is the reviewer's own.
 */
import type { DismissReason } from "@rocky-reviews/core/drafts";
import type { Finding, Severity } from "@rocky-reviews/schema";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { Code } from "../diff/Code.js";
import { Prose } from "../diff/Prose.js";
import type { Language } from "../diff/tokenize.js";
import { useReview } from "./ReviewProvider.js";

export const REASON_LABEL: Record<DismissReason, string> = {
  not_an_issue: "Not a real issue",
  intentional: "Intentional",
  not_worth_it: "Not worth it here",
  handled_elsewhere: "Already handled elsewhere",
};

const REASONS = Object.keys(REASON_LABEL) as DismissReason[];

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const MAC = typeof navigator !== "undefined" && /Mac OS X|iPhone|iPad/.test(navigator.userAgent);

type Props = {
  finding: Finding;
  /** The new-side lines the finding is about, as the diff has them (the suggestion's "−" side). */
  original: readonly string[];
  language: Language;
};

export const DraftCard = ({ finding, original, language }: Props) => {
  const { decisionOf, state, saving, act, sendToAgent, mode, setMode, focused, setFocused } =
    useReview();
  const decision = decisionOf(finding.id);
  const copiedAt = state.drafts.get(finding.id)?.agentPromptCopiedAt ?? null;
  const busy = saving.has(finding.id);
  const editing = mode?.kind === "edit" && mode.findingId === finding.id ? mode : null;
  const dismissing = mode?.kind === "dismiss" && mode.findingId === finding.id;
  const root = useRef<HTMLElement>(null);
  const titleId = `draft-${finding.id}-title`;

  // Focus follows the decision made here: to Undo after a decision, to Accept after an undo, to
  // the first reason or the textarea when those open.
  const restore = useRef<string | null>(null);
  const view = decision.state + (editing ? ":edit" : dismissing ? ":dismiss" : "");
  useEffect(() => {
    const target = restore.current;
    if (target === null) return;
    restore.current = null;
    root.current?.querySelector<HTMLElement>(target)?.focus();
  }, [view]);
  const then = (selector: string, run: () => void) => {
    restore.current = selector;
    setFocused(finding.id);
    run();
  };

  const focusClass = focused === finding.id ? " focus" : "";
  // Actions stay focusable while a decision is saved (a disabled button would drop the focus);
  // `act` ignores a second action on the same draft until the first is answered.
  const common = {
    ref: root,
    "aria-busy": busy,
    id: `draft-${finding.id}`,
    "data-finding": finding.id,
    tabIndex: -1,
  } as const;

  if (decision.state === "dismissed") {
    return (
      <article {...common} className={`collapsed-draft${focusClass}`} aria-labelledby={titleId}>
        <span className="ai-tag">AI draft</span>
        <span className="collapsed-text">
          dismissed · <bdi id={titleId}>{finding.title}</bdi>{" "}
          <span className="reason">({REASON_LABEL[decision.reason]})</span>
        </span>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-role="undo"
          onClick={() => then('[data-role="accept"]', () => void act(finding, { kind: "undo" }))}
        >
          Undo
        </button>
      </article>
    );
  }

  if (decision.state === "accepted") {
    return (
      <article {...common} className={`mine from-draft${focusClass}`} aria-labelledby={titleId}>
        <div className="mine-head">
          <span className="avatar" aria-hidden="true">
            Y
          </span>
          <b>You</b>
          <span className="pending">Pending</span>
          <span className="from-ai">· {decision.edited ? "edited from" : "from"} AI draft</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            data-role="undo"
            onClick={() => then('[data-role="accept"]', () => void act(finding, { kind: "undo" }))}
          >
            Undo
          </button>
        </div>
        <h3 className="draft-title" id={titleId}>
          <bdi>{finding.title}</bdi>
        </h3>
        <p className="mine-body">
          <bdi>
            <Prose text={decision.body} />
          </bdi>
        </p>
        <Suggestion finding={finding} original={original} language={language} />
      </article>
    );
  }

  return (
    <article
      {...common}
      className={`draft sev-${finding.severity}${focusClass}`}
      aria-labelledby={titleId}
      onFocus={() => focused !== finding.id && setFocused(finding.id)}
    >
      <div className="draft-head">
        <span className="ai-tag">AI draft</span>
        <span className={`sev ${finding.severity}`}>{SEVERITY_LABEL[finding.severity]}</span>
        <span className="conf">{finding.confidence}% confident</span>
        <span className="spacer" />
        <span className="private-note">Only you can see this until you accept it</span>
      </div>
      <h3 className="draft-title" id={titleId}>
        <bdi>{finding.title}</bdi>
      </h3>
      {editing ? (
        <EditArea
          finding={finding}
          text={editing.text}
          busy={busy}
          onChange={(text) => setMode({ kind: "edit", findingId: finding.id, text })}
          onSave={(body) =>
            then('[data-role="undo"]', () => void act(finding, { kind: "edit", body }))
          }
          onCancel={() => then('[data-role="edit"]', () => setMode(null))}
        />
      ) : (
        <p className="draft-body">
          <bdi>
            <Prose text={finding.body} />
          </bdi>
        </p>
      )}
      <Suggestion finding={finding} original={original} language={language} />
      {finding.memory.map((ref) => (
        <p key={ref.entryId} className="evidence">
          <span className="mark" aria-hidden="true">
            ◆
          </span>
          <span>
            Project memory: <b>{ref.text}</b> <span className="source">· {ref.source}</span>
          </span>
        </p>
      ))}
      {dismissing ? (
        <div
          className="dismiss-reasons"
          role="group"
          aria-labelledby={`${titleId}-why`}
          onKeyDown={(event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            then('[data-role="dismiss"]', () => setMode(null));
          }}
        >
          <span className="lead" id={`${titleId}-why`}>
            Why? Rocky keeps your reason so future reviews can learn from it.
          </span>
          {REASONS.map((reason, i) => (
            <button
              key={reason}
              type="button"
              className="btn btn-sm"
              data-role={i === 0 ? "first-reason" : undefined}
              onClick={() =>
                then('[data-role="undo"]', () => void act(finding, { kind: "dismiss", reason }))
              }
            >
              {REASON_LABEL[reason]}
            </button>
          ))}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => then('[data-role="dismiss"]', () => setMode(null))}
          >
            Cancel
          </button>
        </div>
      ) : (
        !editing && (
          <div className="draft-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              data-role="accept"
              onClick={() =>
                then('[data-role="undo"]', () => void act(finding, { kind: "accept" }))
              }
            >
              Accept
            </button>
            <button
              type="button"
              className="btn btn-sm"
              data-role="edit"
              onClick={() =>
                then("textarea", () =>
                  setMode({ kind: "edit", findingId: finding.id, text: finding.body }),
                )
              }
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-sm"
              data-role="dismiss"
              onClick={() =>
                then('[data-role="first-reason"]', () =>
                  setMode({ kind: "dismiss", findingId: finding.id }),
                )
              }
            >
              Dismiss
            </button>
            <span className="spacer" />
            {copiedAt !== null && <span className="copied-note">✓ Fix prompt copied</span>}
            <button
              type="button"
              className="btn btn-sm btn-ai"
              data-role="agent"
              onClick={() => {
                setFocused(finding.id);
                void sendToAgent(finding);
              }}
            >
              Send to agent{" "}
              <span className="mark" aria-hidden="true">
                ↗
              </span>
            </button>
          </div>
        )
      )}
    </article>
  );
};

const EditArea = ({
  finding,
  text,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  finding: Finding;
  text: string;
  busy: boolean;
  onChange: (text: string) => void;
  onSave: (body: string) => void;
  onCancel: () => void;
}) => {
  const empty = text.trim() === "";
  const id = `edit-${finding.id}`;
  return (
    <div className="edit-area">
      <label className="sr-only" htmlFor={id}>
        Your comment, edited from the AI draft
      </label>
      <textarea
        id={id}
        rows={4}
        value={text}
        maxLength={65_536}
        aria-keyshortcuts="Meta+Enter Control+Enter Escape"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !empty) {
            e.preventDefault();
            onSave(text);
          }
        }}
      />
      <div className="draft-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={empty || busy}
          onClick={() => onSave(text)}
        >
          Save as my comment
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <span className="compose-hint">
          <span>{MAC ? "⌘↵" : "Ctrl+Enter"} to save</span> · <span>Esc to cancel</span>
        </span>
      </div>
    </div>
  );
};

/** The suggested change as a small diff: the context line, the lines it replaces, the new ones. */
const Suggestion = ({
  finding,
  original,
  language,
}: {
  finding: Finding;
  original: readonly string[];
  language: Language;
}) => {
  const suggestion = finding.suggestion;
  if (suggestion === undefined) return null;
  const rows: { kind: "ctx" | "del" | "add"; text: string }[] = [
    ...(suggestion.context === undefined
      ? []
      : [{ kind: "ctx" as const, text: suggestion.context }]),
    ...original.map((text) => ({ kind: "del" as const, text })),
    ...suggestion.lines.map((text) => ({ kind: "add" as const, text })),
  ];
  const sign = { ctx: " ", del: "−", add: "+" } as const;
  const word = { ctx: "", del: "removed: ", add: "added: " } as const;
  return (
    <figure className="suggestion">
      <figcaption className="suggestion-label">Suggested change</figcaption>
      <div className="suggestion-lines">
        {rows.map((row, i) => (
          <div key={i} className={`ln ${row.kind}`}>
            <span className="sign" aria-hidden="true">
              {sign[row.kind]}
            </span>
            <code className="src">
              {word[row.kind] !== "" && <span className="sr-only">{word[row.kind]}</span>}
              <Code text={row.text} language={language} />
            </code>
          </div>
        ))}
      </div>
    </figure>
  );
};
