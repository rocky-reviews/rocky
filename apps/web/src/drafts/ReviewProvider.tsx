/**
 * The reviewer's drafts and own comments for the page (P6-4, ADR 0027). Loaded from the server
 * for the analysis on screen and written back on every decision, so a reload shows the same
 * review. Decisions are applied at once with core's `applyDraftAction` (the server applies the
 * same function) and reconciled with the server's answer: a refusal from a stale tab shows the
 * server's state, a failure puts the old state back. Nothing here posts to GitHub.
 *
 * P6-6: a draft or comment carried by a review attempt (`posted`, P3-5) is read-only here: no
 * action is sent for it, and a server refusal `already_posted` (the attempt happened in another
 * tab) loads the review again and says so. After Finish review posts, the shell calls `reload`.
 *
 * Also the UI state the draft cards share with the right panel: which draft is being edited or
 * dismissed (the text survives the diff's virtualisation), which one has the focus ring, and
 * jump requests from the panel to a draft or a comment.
 */
import {
  applyDraftAction,
  DRAFT,
  type DraftAction,
  type DraftDecision,
} from "@rocky-reviews/core/drafts";
import type { Finding } from "@rocky-reviews/schema";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type DraftRecord,
  EMPTY_REVIEW,
  parseDraftRecord,
  parseOwnComment,
  parseReviewState,
  type ReviewSource,
  type ReviewState,
} from "../data/review-data.js";
import type { OwnComment } from "../diff/diff-model.js";
import { useDiff } from "../diff/DiffProvider.js";
import { useToast } from "../shell/Toast.js";

/**
 * `promise`, unless `signal` aborts first: then it never settles, so an answer about a pull
 * request that is no longer on screen changes nothing (no state, no toast).
 */
export const untilAborted = <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    promise.then(
      (value) => !signal.aborted && resolve(value),
      (error: unknown) => !signal.aborted && reject(error),
    );
  });

export const TOAST = {
  accepted: "Added to your pending review. Not posted yet.",
  copied: "Fix prompt copied. Paste it into your coding agent.",
  copyFailed: "The fix prompt could not be copied: the browser blocked the clipboard.",
  saveFailed: "Your decision could not be saved. Try again.",
  conflict: "This draft was decided in another tab. It now shows that decision.",
  commentFailed: "Your comment could not be saved. Try again.",
  deleteFailed: "Your comment could not be deleted. Try again.",
  posted: "This was already posted to GitHub, so it can no longer be changed.",
} as const;

export type DraftMode =
  | { readonly kind: "edit"; readonly findingId: string; readonly text: string }
  | { readonly kind: "dismiss"; readonly findingId: string };

/** A request from the right panel to bring something into view (`seq` makes repeats count). */
export type Jump =
  | { readonly kind: "finding"; readonly findingId: string; readonly seq: number }
  | {
      readonly kind: "comment";
      readonly path: string;
      readonly line: number;
      readonly seq: number;
    };

export type ReviewContextValue = {
  /** Decisions and comments are taken only when `ready`: before, they would be lost on load. */
  readonly status: "none" | "loading" | "ready" | "failed";
  /** The diff on screen is from a newer push than the analysis: drafts and comments are hidden. */
  readonly stale: boolean;
  readonly findings: readonly Finding[];
  readonly state: ReviewState;
  readonly decisionOf: (findingId: string) => DraftDecision;
  readonly saving: ReadonlySet<string>;
  readonly act: (finding: Finding, action: DraftAction) => Promise<void>;
  readonly sendToAgent: (finding: Finding) => Promise<void>;
  readonly addComment: (path: string, line: number, body: string) => Promise<boolean>;
  readonly deleteComment: (id: string) => Promise<void>;
  readonly mode: DraftMode | null;
  readonly setMode: (mode: DraftMode | null) => void;
  readonly focused: string | null;
  readonly setFocused: (findingId: string | null) => void;
  readonly jump: Jump | null;
  /** The view that brought a jump's target into view calls this, so it happens once. */
  readonly doneJump: (seq: number) => void;
  readonly jumpToFinding: (findingId: string) => void;
  readonly jumpToComment: (comment: OwnComment) => void;
  /** Loads the review again from the server (after a post, or a refusal because of one). */
  readonly reload: () => void;
};

/** Without a provider: no analysis, nothing to decide. Tests spread it and override fields. */
export const NO_REVIEW: ReviewContextValue = {
  status: "none",
  stale: false,
  findings: [],
  state: EMPTY_REVIEW,
  decisionOf: () => DRAFT,
  saving: new Set(),
  act: async () => {},
  sendToAgent: async () => {},
  addComment: async () => false,
  deleteComment: async () => {},
  mode: null,
  setMode: () => {},
  focused: null,
  setFocused: () => {},
  jump: null,
  doneJump: () => {},
  jumpToFinding: () => {},
  jumpToComment: () => {},
  reload: () => {},
};

export const ReviewContext = createContext<ReviewContextValue>(NO_REVIEW);

export const useReview = (): ReviewContextValue => useContext(ReviewContext);

type Props = {
  source: ReviewSource;
  /** The analysis on screen; `null` when there is none (no drafts, no comments). */
  analysisId: string | null;
  /** The head commit that analysis is for (to tell when the diff is from a newer push). */
  analysisHead: string | null;
  findings: readonly Finding[];
  /** Opens a file in the main column (a jump from the panel). */
  onOpenFile: (path: string) => void;
  children: ReactNode;
};

export const ReviewProvider = ({
  source,
  analysisId,
  analysisHead,
  findings,
  onOpenFile,
  children,
}: Props) => {
  const toast = useToast();
  const { load: diff } = useDiff();
  const stale =
    diff.kind === "ready" && analysisHead !== null && diff.data.headSha !== analysisHead;
  const [status, setStatus] = useState<ReviewContextValue["status"]>(
    analysisId === null ? "none" : "loading",
  );
  const [state, setState] = useState<ReviewState>(EMPTY_REVIEW);
  const [saving, setSaving] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState<DraftMode | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const seq = useRef(0);
  // Decisions on one draft run one after the other (a quick Undo waits for its Accept), each
  // from the latest decision. `drafts` is that decision map, updated synchronously.
  const drafts = useRef<ReadonlyMap<string, DraftRecord>>(EMPTY_REVIEW.drafts);
  const queues = useRef(new Map<string, Promise<void>>());
  // The latest state, for reconciling answers that arrive after other changes.
  const current = useRef(state);
  current.current = state;
  const ready = useRef(false);
  ready.current = status === "ready";
  // One session per analysis on screen: an answer that arrives after it changed is dropped
  // (it is about another pull request's drafts), see `untilAborted`.
  const session = useRef<AbortSignal>(AbortSignal.abort());
  // A reload (P6-6) counts up; the effect below runs again for the same analysis.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    const abort = new AbortController();
    session.current = abort.signal;
    drafts.current = EMPTY_REVIEW.drafts;
    queues.current = new Map();
    ready.current = false;
    setState(EMPTY_REVIEW);
    setSaving(new Set());
    setMode(null);
    setFocused(null);
    if (analysisId === null) {
      setStatus("none");
      return () => abort.abort();
    }
    setStatus("loading");
    source
      .load(analysisId, { signal: abort.signal })
      .then(parseReviewState)
      .then(
        (loaded) => {
          if (abort.signal.aborted) return;
          drafts.current = loaded.drafts;
          ready.current = true;
          setState(loaded);
          setStatus("ready");
        },
        () => !abort.signal.aborted && setStatus("failed"),
      );
    return () => abort.abort();
  }, [source, analysisId, generation]);

  const decisionOf = useCallback(
    (findingId: string) => state.drafts.get(findingId)?.decision ?? DRAFT,
    [state],
  );

  const busy = useCallback((findingId: string, on: boolean) => {
    setSaving((now) => {
      const next = new Set(now);
      if (on) next.add(findingId);
      else next.delete(findingId);
      return next;
    });
  }, []);

  const putDraft = useCallback((findingId: string, record: DraftRecord | undefined) => {
    const next = new Map(drafts.current);
    if (record === undefined) next.delete(findingId);
    else next.set(findingId, record);
    drafts.current = next;
    setState((s) => ({ ...s, drafts: next }));
  }, []);

  const step = useCallback(
    async (finding: Finding, action: DraftAction, scope: AbortSignal) => {
      // Not before the review has loaded (the load would overwrite the decision), and only for
      // the analysis this action was made on.
      if (analysisId === null || !ready.current || scope.aborted) return;
      const before = drafts.current.get(finding.id);
      // Posted (or being posted) to GitHub: read-only, whatever the action (P6-6).
      if (before !== undefined && before.posted !== null) {
        toast(TOAST.posted);
        return;
      }
      const transition = applyDraftAction(before?.decision ?? DRAFT, action, finding);
      if (!transition.ok) return;
      putDraft(finding.id, {
        findingId: finding.id,
        decision: transition.next,
        agentPromptCopiedAt: transition.agentPromptCopied
          ? new Date().toISOString()
          : (before?.agentPromptCopiedAt ?? null),
        posted: null,
      });
      setMode(null);
      setFocused(finding.id);
      if (action.kind === "accept") toast(TOAST.accepted);
      busy(finding.id, true);
      try {
        const answer = await untilAborted(source.decide(analysisId, finding.id, action), scope);
        if (answer.kind === "posted") {
          // Posted from another tab meanwhile: the server's view replaces the page's.
          toast(TOAST.posted);
          reload();
          return;
        }
        putDraft(finding.id, parseDraftRecord(answer.draft));
        if (answer.kind === "conflict") toast(TOAST.conflict);
      } catch {
        if (scope.aborted) return;
        putDraft(finding.id, before);
        if (action.kind !== "send_to_agent") toast(TOAST.saveFailed);
      } finally {
        if (!scope.aborted) busy(finding.id, false);
      }
    },
    [analysisId, source, toast, busy, putDraft, reload],
  );

  const act = useCallback(
    (finding: Finding, action: DraftAction): Promise<void> => {
      const scope = session.current;
      const run = (queues.current.get(finding.id) ?? Promise.resolve()).then(() =>
        step(finding, action, scope),
      );
      queues.current.set(finding.id, run);
      return run;
    },
    [step],
  );

  const sendToAgent = useCallback(
    async (finding: Finding) => {
      try {
        await navigator.clipboard.writeText(finding.agentPrompt);
      } catch {
        toast(TOAST.copyFailed);
        return;
      }
      toast(TOAST.copied);
      await act(finding, { kind: "send_to_agent" });
    },
    [act, toast],
  );

  const addComment = useCallback(
    async (path: string, line: number, body: string): Promise<boolean> => {
      const scope = session.current;
      if (analysisId === null || !ready.current || scope.aborted) return false;
      const temp: OwnComment = {
        id: `pending-${++seq.current}`,
        path,
        line,
        body: body.trim(),
        posted: null,
      };
      setState((s) => ({ ...s, comments: [...s.comments, temp] }));
      try {
        const saved = parseOwnComment(
          await untilAborted(source.addComment(analysisId, { path, line, body }), scope),
        );
        setState((s) => ({
          ...s,
          comments: s.comments.map((c) => (c.id === temp.id ? saved : c)),
        }));
        return true;
      } catch {
        if (scope.aborted) return false;
        setState((s) => ({ ...s, comments: s.comments.filter((c) => c.id !== temp.id) }));
        toast(TOAST.commentFailed);
        return false;
      }
    },
    [analysisId, source, toast],
  );

  const deleteComment = useCallback(
    async (id: string) => {
      const scope = session.current;
      if (analysisId === null || !ready.current || scope.aborted) return;
      const removed = current.current.comments.find((c) => c.id === id);
      if (removed === undefined || id.startsWith("pending-")) return;
      if (removed.posted !== null) {
        toast(TOAST.posted);
        return;
      }
      setState((s) => ({ ...s, comments: s.comments.filter((c) => c.id !== id) }));
      try {
        const answer = await untilAborted(source.deleteComment(analysisId, id), scope);
        if (answer === "posted") {
          toast(TOAST.posted);
          reload();
        }
      } catch {
        if (scope.aborted) return;
        setState((s) => ({ ...s, comments: [...s.comments, removed] }));
        toast(TOAST.deleteFailed);
      }
    },
    [analysisId, source, toast, reload],
  );

  const jumpToFinding = useCallback(
    (findingId: string) => {
      const finding = findings.find((f) => f.id === findingId);
      if (finding === undefined) return;
      setFocused(findingId);
      onOpenFile(finding.path);
      setJump({ kind: "finding", findingId, seq: ++seq.current });
    },
    [findings, onOpenFile],
  );

  const doneJump = useCallback((done: number) => setJump((j) => (j?.seq === done ? null : j)), []);

  const jumpToComment = useCallback(
    (comment: OwnComment) => {
      onOpenFile(comment.path);
      setJump({ kind: "comment", path: comment.path, line: comment.line, seq: ++seq.current });
    },
    [onOpenFile],
  );

  const value = useMemo<ReviewContextValue>(
    () => ({
      status,
      stale,
      findings,
      state,
      decisionOf,
      saving,
      act,
      sendToAgent,
      addComment,
      deleteComment,
      mode,
      setMode,
      focused,
      setFocused,
      jump,
      doneJump,
      jumpToFinding,
      jumpToComment,
      reload,
    }),
    [
      status,
      stale,
      findings,
      state,
      decisionOf,
      saving,
      act,
      sendToAgent,
      addComment,
      deleteComment,
      mode,
      focused,
      jump,
      doneJump,
      jumpToFinding,
      jumpToComment,
      reload,
    ],
  );
  return <ReviewContext value={value}>{children}</ReviewContext>;
};
