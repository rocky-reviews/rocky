/**
 * The file view in the main column (P6-3, POC `renderFile` / `renderNoise`): a sticky header
 * (risk label and score, path, +/−, Mark viewed), the AI strip (what changed, why this level,
 * drafts on the file), the diff, and a footer that moves to the next file in review order.
 * A noise file shows the AI's summary and its raw diff on request.
 *
 * AI notes (flags, hot lines) are shown only when the analysis is for the diff's head commit;
 * after a new push they would point at the wrong lines.
 */
import type { AnalysisDocument, TriagedFileLevel } from "@rocky-reviews/schema";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Selection } from "../shell/Sidebar.js";
import { LEVEL_LABEL } from "../shell/triage-model.js";
import { fileAnnotations, fileTriage, NO_ANNOTATIONS, reviewOrder } from "./annotations.js";
import { DiffBody } from "./DiffBody.js";
import { useDiff } from "./DiffProvider.js";
import { Prose } from "./Prose.js";

export type FileActions = {
  viewed: ReadonlySet<string>;
  onToggleViewed: (path: string) => void;
  onSelect: (selection: Selection) => void;
};

type Props = FileActions & { path: string; analysis: AnalysisDocument };

const LEVEL_WORD: Record<TriagedFileLevel, string> = {
  critical: "critical",
  important: "important",
  normal: "normal",
  low: "low",
};

export const FileView = ({ path, analysis, viewed, onToggleViewed, onSelect }: Props) => {
  const { load, request } = useDiff();
  useEffect(request, [request]);

  const triage = useMemo(() => fileTriage(analysis, path), [analysis, path]);
  const order = useMemo(() => reviewOrder(analysis), [analysis]);
  const next = order[order.indexOf(path) + 1];
  const changed = analysis.provenance.files.find((f) => f.path === path);
  const isViewed = viewed.has(path);
  const [showRaw, setShowRaw] = useState(false);

  // A new file starts at the top; after "next", focus moves to its title.
  const title = useRef<HTMLHeadingElement>(null);
  const focusTitle = useRef(false);
  useEffect(() => {
    setShowRaw(false);
    const card = title.current?.closest("article");
    card?.parentElement?.scrollTo({ top: 0 });
    if (focusTitle.current) {
      title.current?.focus();
      focusTitle.current = false;
    }
  }, [path]);

  const goNext = () => {
    if (next === undefined) return;
    if (!isViewed) onToggleViewed(path);
    focusTitle.current = true;
    onSelect({ kind: "file", path: next });
  };

  const current = load.kind === "ready" && load.data.headSha === analysis.provenance.head.sha;
  const annotations = useMemo(
    () => (current ? fileAnnotations(analysis, path) : NO_ANNOTATIONS),
    [current, analysis, path],
  );

  const showDiff = triage?.kind !== "noise" || showRaw;

  return (
    <>
      <header className="file-head">
        {triage?.kind === "triaged" ? (
          <span className={`risk-label r-${triage.level}`}>
            {LEVEL_LABEL[triage.level]} · {triage.score}
            <span className="sr-only"> risk score</span>
          </span>
        ) : (
          triage?.kind === "noise" && <span className="risk-label r-noise">Noise</span>
        )}
        <h2 className="file-path" id="file-title" tabIndex={-1} ref={title}>
          <bdi>{path}</bdi>
        </h2>
        {changed && (
          <span className="file-size">
            <span className="add">+{changed.additions}</span>{" "}
            <span className="del">−{changed.deletions}</span>
            <span className="sr-only">
              {" "}
              ({changed.additions} added, {changed.deletions} removed)
            </span>
          </span>
        )}
        <button
          type="button"
          className={`btn btn-sm${isViewed || triage?.kind === "noise" ? "" : " btn-primary"}`}
          aria-pressed={isViewed}
          onClick={() => onToggleViewed(path)}
        >
          {isViewed ? "✓ Viewed" : "Mark viewed"}
        </button>
      </header>

      {triage?.kind === "triaged" && (
        <dl className="file-ai">
          <div className="row">
            <dt className="k">What changed</dt>
            <dd>{triage.whatChanged}</dd>
          </div>
          <div className="row">
            <dt className="k">Why {LEVEL_WORD[triage.level]}</dt>
            <dd>{triage.whyThisLevel}</dd>
          </div>
          {triage.findings > 0 && (
            <div className="row">
              <dt className="k">Drafts</dt>
              <dd>
                {triage.findings} {triage.findings === 1 ? "finding" : "findings"} on this file.
              </dd>
            </div>
          )}
        </dl>
      )}

      {triage?.kind === "noise" && (
        <div className="noise-card">
          <p className="noise-title">
            <span className="ai-tag">AI summary</span>
          </p>
          <p className="noise-summary">
            <Prose text={triage.summary} />
          </p>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-expanded={showRaw}
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "Hide raw diff" : "Show raw diff"}
            {changed && ` (+${changed.additions} −${changed.deletions})`}
          </button>
        </div>
      )}

      {showDiff && (
        <DiffArea path={path} stale={load.kind === "ready" && !current} annotations={annotations} />
      )}

      <footer className="file-foot">
        <span className="hint">
          {showDiff && "Select a new-side line number to add your own comment"}
        </span>
        {next !== undefined && (
          <button type="button" className="btn btn-sm" onClick={goNext}>
            {isViewed ? "Next file" : "Mark viewed & next"} <span aria-hidden="true">→</span>
          </button>
        )}
      </footer>
    </>
  );
};

const DiffArea = ({
  path,
  stale,
  annotations,
}: {
  path: string;
  stale: boolean;
  annotations: ReturnType<typeof fileAnnotations>;
}) => {
  const { load } = useDiff();
  if (load.kind === "failed")
    return (
      <p className="diff-status" role="alert">
        The diff could not be loaded.
      </p>
    );
  if (load.kind !== "ready")
    return (
      <p className="diff-status" role="status">
        Loading the diff…
      </p>
    );
  const file = load.data.files.get(path);
  if (file === undefined) return <p className="diff-status">This file is not in the diff.</p>;
  if (file.binary) return <p className="diff-status">Binary file, not shown.</p>;
  if (file.hunks.length === 0)
    return <p className="diff-status">No line changes (renamed or mode changed).</p>;
  return (
    <>
      {stale && (
        <p className="diff-status" role="note">
          The AI notes are for an earlier push, so they are hidden on this diff.
        </p>
      )}
      <DiffBody key={path} path={path} file={file} annotations={annotations} />
    </>
  );
};
