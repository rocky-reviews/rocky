/**
 * One file's diff (P6-3): hunk headers, old/new line numbers, +/− signs, syntax highlighting,
 * hot-line markers, AI flags under their lines, and the reviewer's own comments. Rows are
 * virtualised, so a 5,000-line file renders a screenful at a time.
 *
 * Keyboard: the new-side line numbers are one tab stop (roving tabindex). Arrow keys, Page
 * Up/Down, Home and End move between them; Enter opens the comment composer for that line;
 * in the composer, ⌘/Ctrl+Enter adds and Escape cancels. Focus returns to the line.
 *
 * Every string is PR content or the reviewer's text, rendered as React text only.
 */
import type { DiffFile } from "@rocky-reviews/core/diff";
import type { Flag, FlagKind } from "@rocky-reviews/schema";
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FileAnnotations, HotKind } from "./annotations.js";
import {
  type DiffItem,
  diffItems,
  type DiffLine,
  type DiffRow,
  fileRows,
  type OwnComment,
} from "./diff-model.js";
import { MAX_COMMENT_CHARS, useDiff } from "./DiffProvider.js";
import { Prose } from "./Prose.js";
import { codePoint, splitControls } from "./text.js";
import { type Language, languageFor, tokenize } from "./tokenize.js";
import { useVirtualList } from "./use-virtual-list.js";

const ESTIMATE: Record<DiffItem["kind"], number> = { hunk: 30, note: 20, line: 20, inline: 60 };

const FLAG_LABEL: Record<FlagKind, string> = {
  look: "Look here",
  question: "Your call",
  ok: "Checked",
};

const SIGN = { add: "+", del: "−", ctx: " " } as const;
const SIGN_TEXT = { add: "added", del: "removed", ctx: "" } as const;

/** Rows the keyboard moves by with Page Up/Down. */
const PAGE = 20;

type Props = { path: string; file: DiffFile; annotations: FileAnnotations };

export const DiffBody = ({ path, file, annotations }: Props) => {
  const { comments, addComment, deleteComment } = useDiff();
  const [composing, setComposing] = useState<number | null>(null);
  const rows = useMemo(() => fileRows(file.patch), [file.patch]);
  const language = languageFor(path);
  const mine = useMemo(() => comments.filter((c) => c.path === path), [comments, path]);
  const items = useMemo(
    () => diffItems(rows, annotations, mine, composing),
    [rows, annotations, mine, composing],
  );
  const keys = useMemo(() => items.map((item) => item.key), [items]);
  const estimate = useCallback((i: number) => ESTIMATE[items[i]?.kind ?? "line"], [items]);
  // New-side line numbers in order, and where each one's row is.
  const lines = useMemo(
    () =>
      items.flatMap((item, i) =>
        item.kind === "line" && item.row.newNo !== null ? [{ n: item.row.newNo, i }] : [],
      ),
    [items],
  );
  const [active, setActive] = useState<number | null>(() => lines[0]?.n ?? null);
  const activeIndex = lines.findIndex((l) => l.n === active);
  // The active line and an open composer stay rendered while scrolled away, so neither
  // focus nor the draft is lost when the window moves.
  const activeItem = lines[activeIndex]?.i ?? -1;
  const composerItem = useMemo(
    () => (composing === null ? -1 : keys.indexOf(`i${composing}`)),
    [keys, composing],
  );
  const pinned = useMemo(() => [activeItem, composerItem], [activeItem, composerItem]);
  const { listRef, measureRef, range, parts, reveal } = useVirtualList(keys, estimate, pinned);
  // Drafts by line, kept here so they outlive the composer element.
  const [drafts, setDrafts] = useState<ReadonlyMap<number, string>>(() => new Map());
  const setDraft = useCallback(
    (n: number, text: string | null) =>
      setDrafts((current) => {
        const next = new Map(current);
        if (text === null) next.delete(n);
        else next.set(n, text);
        return next;
      }),
    [],
  );
  const composerFocus = useRef(false);
  const activeRendered =
    activeIndex !== -1 &&
    (lines[activeIndex]?.i ?? -1) >= range.start &&
    (lines[activeIndex]?.i ?? -1) < range.end;

  // Focus a line once its row is rendered. A far jump (End, Home) first scrolls by estimated
  // heights; the rows that arrive are measured, so the next pass lands closer. Bounded retries.
  const pendingFocus = useRef<{ line: number; tries: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null) return;
    const at = lines.find((l) => l.n === pending.line);
    const button = listRef.current?.querySelector<HTMLButtonElement>(
      `button[data-line="${pending.line}"]`,
    );
    if (at === undefined || pending.tries > 10) {
      // Give up on the exact line: focus the nearest rendered one, never leave focus on <body>.
      pendingFocus.current = null;
      const target = at?.i ?? 0;
      const nearest = [
        ...(listRef.current?.querySelectorAll<HTMLButtonElement>("button[data-line]") ?? []),
      ]
        .map((b) => ({
          b,
          d: Math.abs((lines.find((l) => l.n === Number(b.dataset.line))?.i ?? 0) - target),
        }))
        .sort((x, y) => x.d - y.d)[0]?.b;
      if (nearest) {
        setActive(Number(nearest.dataset.line));
        nearest.focus({ preventScroll: true });
      }
    } else if (button) {
      reveal(at.i, button.closest<HTMLElement>(".ln") ?? button);
      button.focus({ preventScroll: true });
      pendingFocus.current = null;
    } else {
      pending.tries++;
      reveal(at.i);
    }
  });
  const focusAfterRender = (line: number) => {
    pendingFocus.current = { line, tries: 0 };
  };

  const focusLine = useCallback(
    (n: number) => {
      const at = lines.find((l) => l.n === n);
      if (at === undefined) return;
      setActive(n);
      focusAfterRender(n);
      reveal(at.i);
    },
    [lines, reveal],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.matches("button[data-line]") || activeIndex === -1) return;
    const to: Record<string, number> = {
      ArrowDown: activeIndex + 1,
      ArrowUp: activeIndex - 1,
      PageDown: activeIndex + PAGE,
      PageUp: activeIndex - PAGE,
      Home: 0,
      End: lines.length - 1,
    };
    const next = to[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const line = lines[Math.max(0, Math.min(lines.length - 1, next))];
    if (line) focusLine(line.n);
  };

  // Tabbing in while the active line is scrolled away: start from the first line on screen.
  const onFocusList = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const first = lines.find((l) => l.i >= range.start && l.i < range.end);
    if (first) focusLine(first.n);
  };

  const compose = useCallback((n: number) => {
    setActive(n);
    composerFocus.current = true;
    setComposing(n);
  }, []);
  const closeComposer = useCallback(
    (n: number) => {
      setDraft(n, null);
      focusAfterRender(n);
      setComposing(null);
    },
    [setDraft],
  );
  const submit = useCallback(
    (n: number, body: string) => {
      addComment(path, n, body);
      setDraft(n, null);
      focusAfterRender(n);
      setComposing(null);
    },
    [addComment, path, setDraft],
  );
  const remove = useCallback(
    (comment: OwnComment) => {
      deleteComment(comment.id);
      focusAfterRender(comment.line);
    },
    [deleteComment],
  );

  // Line-number columns fit the longest number in the file.
  const digits = useMemo(
    () => String(rows.reduce((max, row) => Math.max(max, lineMax(row)), 1)).length,
    [rows],
  );

  return (
    <div
      ref={listRef}
      className="diff"
      role="group"
      aria-label={`Diff of ${path}`}
      style={{ "--ln-digits": digits } as CSSProperties}
      tabIndex={activeRendered ? -1 : 0}
      onKeyDown={onKeyDown}
      onFocus={onFocusList}
    >
      {parts.map((part) =>
        part.kind === "spacer" ? (
          <div key={part.key} style={{ height: part.height }} aria-hidden="true" />
        ) : (
          items.slice(part.start, part.end).map((item) => {
            switch (item.kind) {
              case "hunk":
                return (
                  <div key={item.key} ref={measureRef} data-vkey={item.key} className="hunk-head">
                    <code>
                      <Code text={item.header} language="plain" />
                    </code>
                  </div>
                );
              case "note":
                return (
                  <div key={item.key} ref={measureRef} data-vkey={item.key} className="diff-note">
                    <bdi>{item.text}</bdi>
                  </div>
                );
              case "line":
                return (
                  <LineRow
                    key={item.key}
                    vkey={item.key}
                    measureRef={measureRef}
                    row={item.row}
                    hot={item.hot}
                    language={language}
                    focusable={item.row.newNo !== null && item.row.newNo === active}
                    onCompose={compose}
                  />
                );
              case "inline":
                return (
                  <div key={item.key} ref={measureRef} data-vkey={item.key} className="inline">
                    {item.flags.map((flag, i) => (
                      <FlagNote key={i} flag={flag} />
                    ))}
                    {item.comments.map((comment) => (
                      <MyComment key={comment.id} comment={comment} onDelete={remove} />
                    ))}
                    {item.composing && (
                      <Composer
                        line={item.line}
                        body={drafts.get(item.line) ?? ""}
                        focusOnMount={composerFocus}
                        onChange={setDraft}
                        onCancel={closeComposer}
                        onSubmit={submit}
                      />
                    )}
                  </div>
                );
            }
          })
        ),
      )}
    </div>
  );
};

const lineMax = (row: DiffRow): number =>
  row.kind === "line" ? Math.max(row.oldNo ?? 0, row.newNo ?? 0) : 0;

/** Code as highlighted text; invisible characters show as visible markers. */
const Code = ({ text, language }: { text: string; language: Language }) =>
  tokenize(text, language).map((token, i) => {
    const parts = splitControls(token.text).map((part, j) =>
      part.control ? (
        <span key={j} className="bidi-ctl" title={`Invisible character ${codePoint(part.text)}`}>
          {codePoint(part.text)}
        </span>
      ) : (
        part.text
      ),
    );
    return token.kind === "plain" ? (
      <span key={i}>{parts}</span>
    ) : (
      <span key={i} className={`tk-${token.kind}`}>
        {parts}
      </span>
    );
  });

type LineProps = {
  vkey: string;
  measureRef: (el: HTMLElement | null) => (() => void) | undefined;
  row: DiffLine;
  hot: HotKind | null;
  language: Language;
  focusable: boolean;
  onCompose: (line: number) => void;
};

const LineRow = memo(function LineRow({
  vkey,
  measureRef,
  row,
  hot,
  language,
  focusable,
  onCompose,
}: LineProps) {
  const newNo = row.newNo;
  return (
    <div
      ref={measureRef}
      data-vkey={vkey}
      className={`ln ${row.type}${hot === null ? "" : ` hot hot-${hot}`}`}
    >
      <span className="no" aria-hidden="true">
        {row.oldNo}
      </span>
      {newNo === null ? (
        <span className="no" aria-hidden="true" />
      ) : (
        <button
          type="button"
          className="no new"
          data-line={newNo}
          tabIndex={focusable ? 0 : -1}
          aria-label={`Comment on line ${newNo}`}
          title="Add a comment"
          onClick={() => onCompose(newNo)}
        >
          {newNo}
        </button>
      )}
      <span className="sign" aria-hidden="true">
        {SIGN[row.type]}
      </span>
      <code className="src">
        {SIGN_TEXT[row.type] !== "" && <span className="sr-only">{SIGN_TEXT[row.type]}: </span>}
        <Code text={row.text} language={language} />
      </code>
    </div>
  );
});

const FlagNote = ({ flag }: { flag: Flag }) => (
  <div className={`flag ${flag.kind}`}>
    <span className="k">
      <span className="mark" aria-hidden="true">
        {flag.kind === "ok" ? "✓" : "✦"}
      </span>{" "}
      {FLAG_LABEL[flag.kind]}
      <span className="sr-only"> (AI)</span>
    </span>
    <bdi>
      <Prose text={flag.text} />
    </bdi>
  </div>
);

const MyComment = ({
  comment,
  onDelete,
}: {
  comment: OwnComment;
  onDelete: (comment: OwnComment) => void;
}) => (
  <div className="mine">
    <div className="mine-head">
      <span className="avatar" aria-hidden="true">
        Y
      </span>
      <b>You</b>
      <span className="pending">Pending</span>
      <span className="spacer" />
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        aria-label={`Delete your comment on line ${comment.line}`}
        onClick={() => onDelete(comment)}
      >
        Delete
      </button>
    </div>
    <p className="mine-body">{comment.body}</p>
  </div>
);

const MAC = typeof navigator !== "undefined" && /Mac OS X|iPhone|iPad/.test(navigator.userAgent);

const Composer = ({
  line,
  body,
  focusOnMount,
  onChange,
  onCancel,
  onSubmit,
}: {
  line: number;
  body: string;
  /** Set when the composer was just opened; it takes focus once, not on a later remount. */
  focusOnMount: { current: boolean };
  onChange: (line: number, body: string) => void;
  onCancel: (line: number) => void;
  onSubmit: (line: number, body: string) => void;
}) => {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!focusOnMount.current) return;
    focusOnMount.current = false;
    box.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const empty = body.trim() === "";
  const id = `compose-${line}`;
  return (
    <div className="compose">
      <label className="sr-only" htmlFor={id}>
        Your comment on line {line}
      </label>
      <textarea
        id={id}
        ref={box}
        rows={3}
        value={body}
        maxLength={MAX_COMMENT_CHARS}
        placeholder={`Leave a comment on line ${line}…`}
        aria-keyshortcuts="Meta+Enter Control+Enter Escape"
        onChange={(e) => onChange(line, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel(line);
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !empty) {
            e.preventDefault();
            onSubmit(line, body);
          }
        }}
      />
      <div className="compose-actions">
        <span className="compose-hint">
          <span>{MAC ? "⌘↵" : "Ctrl+Enter"} to add</span> · <span>Esc to cancel</span>
        </span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => onCancel(line)}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={empty}
          onClick={() => onSubmit(line, body)}
        >
          Add comment
        </button>
      </div>
    </div>
  );
};
