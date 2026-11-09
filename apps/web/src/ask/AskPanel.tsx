/**
 * The right panel's Ask tab (P9-2, ADR 0041; POC `renderPanel`'s ask branch): a reviewer asks
 * about the pull request and Rocky answers from the repository's index, with clickable
 * `file:line` citations that open the cited lines on GitHub at the indexed commit.
 *
 * States: the index's (checking, not indexed, indexing, off, could not be checked), and per
 * question: "Reading the code…", the answer with its citations, no good answer, an error. The
 * answer is model text: shown as text with inline code and bold only (`InlineText`), never as
 * HTML or links; the only links are the citations, built by `citationUrl` from checked parts.
 * Nothing here acts on an answer. Questions and answers live in this page only (nothing is
 * stored).
 *
 * Enter sends, Shift+Enter starts a new line. `/` (Shell) opens this tab, focuses the box and
 * attaches the code selected in the diff, shown as a chip that can be removed.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { InlineText } from "../briefing/inline-text.js";
import type { PullRef } from "../data/shell-data.js";
import {
  lineLabel,
  MAX_QUESTION_CHARS,
  parseAskIndex,
  parseAskReply,
  type AskIndex,
  type AskIndexProblem,
  type AskProblem,
  type AskReply,
  type AskSelection,
  type AskSource,
} from "./ask-data.js";

type IndexState =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  | { readonly kind: "known"; readonly index: AskIndex }
  | { readonly kind: "problem"; readonly problem: AskIndexProblem };

interface Turn {
  readonly id: number;
  readonly question: string;
  readonly selection: AskSelection | null;
  readonly reply: AskReply | "pending";
}

/** While a first index is built, the panel asks again this often (only while it is shown). */
export const INDEXING_POLL_MS = 20_000;

export const SUGGESTED_QUESTIONS = [
  "Who calls the changed code?",
  "Is this change covered by tests?",
  "What else depends on this?",
] as const;

const PROBLEM_TEXT: Readonly<Record<AskProblem, string>> = {
  not_indexed: "This repository isn’t indexed yet, so Rocky can’t read its code to answer.",
  indexing: "Rocky is still indexing this repository. Ask again once the index is ready.",
  rate_limited: "You’ve asked a lot in the last minute. Wait a moment, then ask again.",
  model_unavailable: "The AI model didn’t answer. Try again.",
  answer_failed: "The AI model’s answer couldn’t be used. Try asking another way.",
  forge_unavailable: "GitHub didn’t answer while Rocky read the code. Try again.",
  unavailable: "Ask isn’t available on this Rocky right now.",
  invalid_question: "Rocky can’t send this question. Shorten it, or remove unusual characters.",
  not_found: "This pull request isn’t in Rocky, or you can’t read its repository on GitHub.",
  signed_out: "Your session ended. Reload the page and sign in to ask.",
  failed: "Something went wrong while asking. Try again.",
};

const NO_ANSWER_TEXT = {
  no_context: "Rocky found no code in the index it could read for this question.",
  uncited: "Rocky’s answer didn’t point to code it was shown, so it isn’t shown.",
  model: "The code Rocky found doesn’t answer this.",
} as const;

/** Paragraphs of model text, each as plain text with inline code and bold. */
const Answer = ({ text }: { text: string }) =>
  text
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((p, i) => (
      <p key={i} className="ask-text">
        <InlineText text={p} />
      </p>
    ));

const SelectionChip = ({
  selection,
  onRemove,
}: {
  selection: AskSelection;
  onRemove?: () => void;
}) => (
  <span className="ask-selection">
    <span className="ask-selection-label">
      <span className="sr-only">With the selected code from </span>
      <bdi>{lineLabel(selection)}</bdi>
    </span>
    {onRemove !== undefined && (
      <button
        type="button"
        className="ask-selection-remove"
        aria-label="Remove the selected code"
        onClick={onRemove}
      >
        <span aria-hidden="true">✕</span>
      </button>
    )}
  </span>
);

const Reply = ({
  reply,
  retryDisabled,
  onRetry,
}: {
  reply: AskReply | "pending";
  /** Another question is being answered: a retry would not be sent. */
  retryDisabled: boolean;
  onRetry: () => void;
}) => {
  if (reply === "pending")
    return (
      <div className="chat-a typing" role="status">
        Reading the code…
      </div>
    );
  switch (reply.kind) {
    case "answered":
      return (
        <div className="chat-a">
          <span className="sr-only">Rocky (AI) answered: </span>
          <Answer text={reply.answer} />
          <ul className="ask-cites" aria-label="Cited code">
            {reply.citations.map((c) => (
              <li key={`${c.path}:${c.startLine}:${c.endLine}`}>
                <a className="cite" href={c.url} target="_blank" rel="noopener noreferrer">
                  <bdi>{lineLabel(c)}</bdi>
                  <span className="sr-only"> (opens on GitHub in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      );
    case "no_answer":
      return (
        <div className="chat-a no-answer">
          <p className="ask-text">
            <strong>No good answer.</strong> {NO_ANSWER_TEXT[reply.reason]}
          </p>
          {reply.note !== null && (
            <p className="ask-text ask-note">
              <InlineText text={reply.note} />
            </p>
          )}
        </div>
      );
    case "error":
      return (
        <div className="chat-a ask-error" role="alert">
          <p className="ask-text">{PROBLEM_TEXT[reply.problem]}</p>
          {reply.problem !== "signed_out" &&
            reply.problem !== "not_found" &&
            reply.problem !== "invalid_question" && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={retryDisabled}
                onClick={onRetry}
              >
                Try again
              </button>
            )}
        </div>
      );
  }
};

const IndexNote = ({ state, onRetry }: { state: IndexState; onRetry: () => void }) => {
  if (state.kind === "idle" || state.kind === "checking")
    return (
      <p className="placeholder" role="status">
        Checking the repository index…
      </p>
    );
  if (state.kind === "problem")
    return (
      <div className="ask-banner" role="alert">
        <p>
          {state.problem === "signed_out"
            ? "Your session ended. Reload the page and sign in to ask."
            : state.problem === "not_found"
              ? "This pull request isn’t in Rocky, or you can’t read its repository on GitHub."
              : "Rocky couldn’t check this repository’s index."}
        </p>
        {state.problem === "failed" && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}>
            Try again
          </button>
        )}
      </div>
    );
  switch (state.index.status) {
    case "ready":
      return null;
    case "not_indexed":
      return (
        <div className="ask-banner" role="note">
          <p>
            <strong>Not indexed yet.</strong> Rocky reads a repository’s code from its index, and
            this one has none yet. The index is built when the default branch gets a push.
          </p>
        </div>
      );
    case "indexing":
      return (
        <div className="ask-banner" role="status">
          <p>
            <strong>Indexing…</strong> Rocky is reading this repository’s code. Ask can answer once
            the first index is done.
          </p>
        </div>
      );
    case "off":
      return (
        <div className="ask-banner" role="note">
          <p>
            <strong>Ask is off.</strong> This Rocky has no embedding model configured, so it can’t
            search the code. An operator turns it on.
          </p>
        </div>
      );
  }
};

type Props = {
  source: AskSource;
  pull: PullRef;
  /** The tab is shown: the index is checked the first time, and polled while it is built. */
  active: boolean;
  /** Code selected in the diff when `/` was pressed. */
  selection: AskSelection | null;
  onClearSelection: () => void;
  /** Bumped to move focus to the question box (`/`). */
  focusRequest: number;
};

export const AskPanelContent = ({
  source,
  pull,
  active,
  selection,
  onClearSelection,
  focusRequest,
}: Props) => {
  const [indexState, setIndexState] = useState<IndexState>({ kind: "idle" });
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const note = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const inFlight = useRef<AbortController | null>(null);
  const boxId = useId();
  const hintId = useId();

  const check = useCallback(
    (signal?: AbortSignal) => {
      setIndexState((s) => (s.kind === "known" ? s : { kind: "checking" }));
      source.index(pull, signal === undefined ? {} : { signal }).then(
        (answer) => {
          if (signal?.aborted === true) return;
          const parsed = parseAskIndex(answer);
          setIndexState(
            parsed.ok
              ? { kind: "known", index: parsed.index }
              : { kind: "problem", problem: parsed.problem },
          );
        },
        () => {
          if (signal?.aborted !== true) setIndexState({ kind: "problem", problem: "failed" });
        },
      );
    },
    [source, pull],
  );

  // The index is checked once, when the tab is first shown. (Not cancelled by a re-render: the
  // check itself moves the state on, which must not drop its own answer.)
  const checkStarted = useRef(false);
  useEffect(() => {
    if (!active || checkStarted.current) return;
    checkStarted.current = true;
    check();
  }, [active, check]);

  // A first index is on its way: ask again now and then, while the tab is shown.
  const indexing = indexState.kind === "known" && indexState.index.status === "indexing";
  useEffect(() => {
    if (!active || !indexing) return;
    const abort = new AbortController();
    const timer = window.setInterval(() => check(abort.signal), INDEXING_POLL_MS);
    return () => {
      window.clearInterval(timer);
      abort.abort();
    };
  }, [active, indexing, check]);

  useEffect(() => () => inFlight.current?.abort(), []);

  // `/`: once the panel (or its drawer) has settled and the index's state is known, focus the
  // box if it takes questions, or else the index's state, which is then read out (`/` is never
  // silent). The request is used up either way: an index that becomes ready later (the poll)
  // never pulls focus into the box on its own.
  const ready = indexState.kind === "known" && indexState.index.status === "ready";
  const settledIndex = indexState.kind === "known" || indexState.kind === "problem";
  const focusDone = useRef(0);
  useEffect(() => {
    if (focusRequest === focusDone.current || !settledIndex) return;
    focusDone.current = focusRequest;
    const target = ready ? box : note;
    const frame = window.requestAnimationFrame(() =>
      window.setTimeout(() => target.current?.focus(), 0),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, ready, settledIndex]);

  // New turns scroll into view (POC: the panel scrolls to the bottom).
  useEffect(() => {
    const el = body.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const pending = turns.some((t) => t.reply === "pending");

  /** Asks; false (and nothing changes) when no question can be sent now. */
  const send = (question: string, attached: AskSelection | null): boolean => {
    const text = question.trim();
    if (text === "" || text.length > MAX_QUESTION_CHARS || !ready || pending) return false;
    const id = nextId.current++;
    setTurns((all) => [...all, { id, question: text, selection: attached, reply: "pending" }]);
    const abort = new AbortController();
    inFlight.current = abort;
    const settle = (reply: AskReply) => {
      if (abort.signal.aborted) return;
      setTurns((all) => all.map((t) => (t.id === id ? { ...t, reply } : t)));
      // The server says the index moved under us: show its state again.
      if (
        reply.kind === "error" &&
        (reply.problem === "not_indexed" || reply.problem === "indexing")
      )
        check();
    };
    source
      .ask(pull, attached === null ? { question: text } : { question: text, selection: attached }, {
        signal: abort.signal,
      })
      .then(
        (answer) => settle(parseAskReply(pull, answer)),
        () => settle({ kind: "error", problem: "failed" }),
      );
    return true;
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!send(draft, selection)) return;
    setDraft("");
    onClearSelection();
  };

  /** A suggested question takes the selected code with it, as a typed one does. */
  const suggest = (question: string) => {
    if (send(question, selection)) onClearSelection();
  };

  /** The failed turn gives way to the new one only once that one is sent. */
  const retry = (turn: Turn) => {
    if (send(turn.question, turn.selection)) setTurns((all) => all.filter((t) => t !== turn));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
    // As in the POC: Esc leaves the box, so the single-key shortcuts work again.
    if (event.key === "Escape") event.currentTarget.blur();
  };

  const indexedSha =
    indexState.kind === "known" && indexState.index.status === "ready"
      ? indexState.index.indexedSha
      : null;
  const updating =
    indexState.kind === "known" && indexState.index.status === "ready" && indexState.index.updating;

  return (
    <>
      <div className="panel-body ask-body" ref={body}>
        {/* Focused by `/` while Ask cannot take a question, so its state is read out. It is never
            empty, so focus stays on it when the index becomes ready meanwhile. */}
        <div className="ask-index-state" ref={note} tabIndex={-1}>
          <IndexNote state={indexState} onRetry={() => check()} />
          {turns.length === 0 && ready && (
            <p className="ask-hint">
              Ask about this PR. Answers come from the repository’s indexed code, with links to the
              lines they rest on. Select code in the diff and press <kbd>/</kbd> to ask about it.
            </p>
          )}
          {indexedSha !== null && (
            <p className="ask-index-note">
              Code indexed at <code>{indexedSha.slice(0, 7)}</code>
              {updating ? ", a newer push is being indexed." : "."}
            </p>
          )}
        </div>
        {turns.length > 0 && (
          <ol className="chat" aria-label="Questions and answers">
            {turns.map((turn) => (
              <li key={turn.id} className="chat-turn">
                <div className="chat-q">
                  <span className="sr-only">You asked: </span>
                  <bdi>{turn.question}</bdi>
                  {turn.selection !== null && <SelectionChip selection={turn.selection} />}
                </div>
                <Reply reply={turn.reply} retryDisabled={pending} onRetry={() => retry(turn)} />
              </li>
            ))}
          </ol>
        )}
      </div>
      <form className="chat-input" onSubmit={submit} aria-label="Ask about this PR">
        {ready && (
          <div className="suggest" aria-label="Suggested questions" role="group">
            {SUGGESTED_QUESTIONS.map((q) => (
              <button key={q} type="button" disabled={pending} onClick={() => suggest(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {selection !== null && <SelectionChip selection={selection} onRemove={onClearSelection} />}
        <label className="sr-only" htmlFor={boxId}>
          Your question
        </label>
        <div className="chat-box">
          <textarea
            id={boxId}
            ref={box}
            rows={2}
            maxLength={MAX_QUESTION_CHARS}
            placeholder="Ask anything about this change…"
            aria-describedby={hintId}
            value={draft}
            disabled={!ready}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={!ready || pending || draft.trim() === ""}
          >
            Ask
          </button>
        </div>
        <p className="chat-hint" id={hintId}>
          Enter to send · Shift+Enter for a new line
        </p>
      </form>
    </>
  );
};
