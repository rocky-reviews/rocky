/**
 * One file's diff (P6-3): hunk headers, old/new line numbers, +/− signs, syntax highlighting,
 * hot-line markers, AI flags and AI drafts (P6-4) under their lines, and the reviewer's own
 * comments (kept on the server, P6-4). Rows are virtualised, so a 5,000-line file renders a
 * screenful at a time.
 *
 * Keyboard: the new-side line numbers are one tab stop (roving tabindex). Arrow keys, Page
 * Up/Down, Home and End move between them; Enter opens the comment composer for that line;
 * in the composer, ⌘/Ctrl+Enter adds and Escape cancels. Focus returns to the line.
 *
 * Every string is PR content or the reviewer's text, rendered as React text only.
 */
import type { DiffFile } from "@rocky-reviews/core/diff";
import type { Finding, Flag, FlagKind } from "@rocky-reviews/schema";
import {
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
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
import { DraftCard, PostedPill } from "../drafts/DraftCard.js";
import { useReview } from "../drafts/ReviewProvider.js";
import { MAX_COMMENT_CHARS } from "./DiffProvider.js";
import { Prose } from "./Prose.js";
import { Code } from "./Code.js";
import { type Language, languageFor } from "./tokenize.js";
import { useVirtualList } from "./use-virtual-list.js";
import { Author } from "../drafts/Author.js";

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

type Props = {
  path: string;
  file: DiffFile;
  annotations: FileAnnotations;
  /**
   * P5-3: a finding's line to open at. Read on mount (the body is keyed by path): that line,
   * or the nearest new-side line the diff shows, starts active and takes focus.
   */
  target?: number | undefined;
  /** This file's AI drafts (none when the analysis is for another push). */
  findings?: readonly Finding[];
  /**
   * Whether own comments are shown and taken: not on a diff newer than the analysis (they are
   * stored against the analysed lines), nor before the reviewer's review has loaded.
   */
  commentable?: boolean;
};

const NO_FINDINGS: readonly Finding[] = [];
const NO_COMMENTS: readonly OwnComment[] = [];

/** The new-side line nearest `target` (the earlier one on a tie). */
const nearestLine = (lines: readonly { n: number }[], target: number): number | undefined =>
  lines.reduce<number | undefined>(
    (best, { n }) =>
      best === undefined || Math.abs(n - target) < Math.abs(best - target) ? n : best,
    undefined,
  );

export const DiffBody = ({
  path,
  file,
  annotations,
  target,
  findings = NO_FINDINGS,
  commentable = true,
}: Props) => {
  const { state, addComment, deleteComment, mode, jump, doneJump } = useReview();
  const comments = state.comments;
  const [composing, setComposing] = useState<number | null>(null);
  const rows = useMemo(() => fileRows(file.patch), [file.patch]);
  const language = languageFor(path);
  const mine = useMemo(
    () => (commentable ? comments.filter((c) => c.path === path) : NO_COMMENTS),
    [commentable, comments, path],
  );
  const items = useMemo(
    () => diffItems(rows, annotations, mine, composing, findings),
    [rows, annotations, mine, composing, findings],
  );
  // New-side text by line number: a suggestion shows the lines it replaces.
  const newText = useMemo(() => {
    const map = new Map<number, string>();
    for (const row of rows)
      if (row.kind === "line" && row.newNo !== null) map.set(row.newNo, row.text);
    return map;
  }, [rows]);
  const originalOf = useCallback(
    (finding: Finding) => {
      const lines: string[] = [];
      for (let n = finding.range.start; n <= finding.range.end; n++) {
        const text = newText.get(n);
        if (text !== undefined) lines.push(text);
      }
      return lines;
    },
    [newText],
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
  const [opening] = useState(() => (target === undefined ? undefined : nearestLine(lines, target)));
  const [active, setActive] = useState<number | null>(() => opening ?? lines[0]?.n ?? null);
  const activeIndex = lines.findIndex((l) => l.n === active);
  // The active line and an open composer stay rendered while scrolled away, so neither
  // focus nor the draft is lost when the window moves.
  const activeItem = lines[activeIndex]?.i ?? -1;
  const composerItem = useMemo(
    () => (composing === null ? -1 : keys.indexOf(`i${composing}`)),
    [keys, composing],
  );
  // A draft being edited keeps its text box rendered while scrolled away, like the composer.
  const editingItem = useMemo(() => {
    const finding = mode === null ? undefined : findings.find((f) => f.id === mode.findingId);
    return finding === undefined ? -1 : keys.indexOf(`i${finding.range.end}`);
  }, [keys, mode, findings]);
  const pinned = useMemo(
    () => [activeItem, composerItem, editingItem],
    [activeItem, composerItem, editingItem],
  );
  const { listRef, measureRef, range, parts, reveal, firstOnScreen } = useVirtualList(
    keys,
    estimate,
    pinned,
  );
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
  // `center`: a finding opened from the change map sits mid-screen, with the code around it.
  const pendingFocus = useRef<{ line: number; tries: number; center?: boolean } | null>(null);
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
      const row = button.closest<HTMLElement>(".ln") ?? button;
      if (pending.center === true) row.scrollIntoView({ block: "center" });
      reveal(at.i, row);
      button.focus({ preventScroll: true });
      pendingFocus.current = null;
    } else {
      pending.tries++;
      reveal(at.i);
    }
  });
  // A jump from the right panel (P6-4), or a restore (P8-2b): bring the draft card (or the
  // comment's line) into view and focus it, once its row has been rendered.
  const pendingCard = useRef<{ i: number; selector: string; tries: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingCard.current;
    if (pending === null) return;
    const el = listRef.current?.querySelector<HTMLElement>(pending.selector);
    if (el) {
      reveal(pending.i, el);
      liftAboveToast(el);
      el.focus({ preventScroll: true });
      pendingCard.current = null;
    } else if (pending.tries++ < 10) {
      reveal(pending.i);
    } else {
      pendingCard.current = null;
    }
  });
  const focusAfterRender = (line: number) => {
    pendingFocus.current = { line, tries: 0 };
  };

  // P5-3: opened at a finding. An effect, declared after useVirtualList, so the list has found
  // its scroller; the next render reveals and focuses the line (the pass above).
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (opening === undefined) return;
    pendingFocus.current = { line: opening, tries: 0, center: true };
    rerender();
  }, [opening]);

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

  useEffect(() => {
    if (jump === null) return;
    if (jump.kind === "finding") {
      const finding = findings.find((f) => f.id === jump.findingId);
      if (finding === undefined) return;
      doneJump(jump.seq);
      const i = keys.indexOf(`i${finding.range.end}`);
      if (i === -1) return;
      pendingCard.current = { i, selector: `[data-finding="${CSS.escape(finding.id)}"]`, tries: 0 };
      reveal(i);
    } else if (jump.kind === "comment" && jump.path === path) {
      doneJump(jump.seq);
      focusLine(jump.line);
    }
  }, [jump, doneJump, findings, keys, reveal, path, focusLine]);

  // From a focused line, or from the list itself after a click on code (H4-13).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const onList = target === event.currentTarget;
    if ((!onList && !target.matches("button[data-line]")) || activeIndex === -1) return;
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
  // H4-13: only for keyboard focus. A click or tap on code also focuses the list (it is
  // focusable), and moving focus to a line from there would scroll and drop a text selection;
  // the browser's :focus-visible heuristic tells the two apart.
  const onFocusList = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (!event.currentTarget.matches(":focus-visible")) return;
    const from = firstOnScreen();
    // Nothing on screen: the last rendered line before the window's end, never the overscan
    // above (that would scroll up).
    const first =
      lines.find((l) => l.i >= from && l.i < range.end) ??
      lines.findLast((l) => l.i >= range.start && l.i < range.end);
    if (first) focusLine(first.n);
  };

  // H4-13: a click on code (or a row's blank space, a hunk header, a flag) makes the nearest
  // line active, so Tab and the arrows start there. Only the roving tab stop moves: no focus,
  // no scroll, and a drag's text selection is left alone. Buttons, links, text boxes and cards
  // keep their own behaviour.
  const onClickList = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button, a, textarea, input, .draft, .mine, .compose") !== null) return;
    const key = target.closest<HTMLElement>("[data-vkey]")?.dataset.vkey;
    const at = key === undefined ? -1 : keys.indexOf(key);
    if (at === -1) return;
    const nearest = lines.reduce<{ n: number; i: number } | undefined>(
      (best, l) => (best === undefined || Math.abs(l.i - at) < Math.abs(best.i - at) ? l : best),
      undefined,
    );
    if (nearest) setActive(nearest.n);
  };

  const compose = useCallback(
    (n: number) => {
      setActive(n);
      if (!commentable) return;
      composerFocus.current = true;
      setComposing(n);
    },
    [commentable],
  );
  // A composer left open when comments stop being taken (a newer push) closes.
  useEffect(() => {
    if (!commentable) setComposing(null);
  }, [commentable]);
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
      setDraft(n, null);
      focusAfterRender(n);
      setComposing(null);
      // Shown at once; if the server refuses it, the composer opens again with the text.
      void addComment(path, n, body).then((saved) => {
        if (saved) return;
        setDraft(n, body);
        composerFocus.current = true;
        setComposing(n);
      });
    },
    [addComment, path, setDraft],
  );
  const remove = useCallback(
    (comment: OwnComment) => {
      void deleteComment(comment.id);
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
      onClick={onClickList}
    >
      {/* One flat keyed list: a row keeps its element (and focus) when runs merge or split. */}
      {parts.flatMap((part) =>
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
                    commentable={commentable}
                    onCompose={compose}
                  />
                );
              case "inline":
                return (
                  <div key={item.key} ref={measureRef} data-vkey={item.key} className="inline">
                    {item.flags.map((flag, i) => (
                      <FlagNote key={i} flag={flag} />
                    ))}
                    {item.findings.map((finding) => (
                      <DraftCard
                        key={finding.id}
                        finding={finding}
                        original={originalOf(finding)}
                        language={language}
                      />
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

/**
 * Room left under a revealed card for the toast region (P8-2b, UI verifier): `reveal` scrolls
 * the least it can, so a card below the fold lands on the viewport's bottom edge, where the
 * toast ("Restored as a draft…") covers its last lines and its actions. A card that ends within
 * this much of the bottom is lifted, never past its own top (a tall card keeps its head on
 * screen at 375 px).
 */
const TOAST_CLEARANCE = 96;
const liftAboveToast = (el: HTMLElement): void => {
  let box = el.parentElement;
  while (
    box !== null &&
    !(box.scrollHeight > box.clientHeight + 1 && getComputedStyle(box).overflowY !== "visible")
  )
    box = box.parentElement;
  if (box === null) return;
  const card = el.getBoundingClientRect();
  const view = box.getBoundingClientRect();
  const overlap = card.bottom - (view.bottom - TOAST_CLEARANCE);
  if (overlap <= 0) return;
  box.scrollTop += Math.min(overlap, Math.max(0, card.top - view.top - 8));
};

const lineMax = (row: DiffRow): number =>
  row.kind === "line" ? Math.max(row.oldNo ?? 0, row.newNo ?? 0) : 0;

type LineProps = {
  vkey: string;
  measureRef: (el: HTMLElement | null) => (() => void) | undefined;
  row: DiffLine;
  hot: HotKind | null;
  language: Language;
  focusable: boolean;
  commentable: boolean;
  onCompose: (line: number) => void;
};

const LineRow = memo(function LineRow({
  vkey,
  measureRef,
  row,
  hot,
  language,
  focusable,
  commentable,
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
          {...(commentable
            ? { "aria-label": `Comment on line ${newNo}`, title: "Add a comment" }
            : { "aria-label": `Line ${newNo}`, "aria-disabled": true })}
          onClick={() => onCompose(newNo)}
        >
          {newNo}
        </button>
      )}
      {/* H4-17: the sign is announced from its unselectable column, so copied code is only code. */}
      <span className="sign">
        <span aria-hidden="true">{SIGN[row.type]}</span>
        {SIGN_TEXT[row.type] !== "" && <span className="sr-only">{SIGN_TEXT[row.type]}: </span>}
      </span>
      <code className="src">
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
      <span className="sr-only no-copy"> (AI)</span>
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
      <Author />
      <PostedPill posted={comment.posted} />
      <span className="spacer" />
      {comment.posted === null && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-label={`Delete your comment on line ${comment.line}`}
          onClick={() => onDelete(comment)}
        >
          Delete
        </button>
      )}
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
