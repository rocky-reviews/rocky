/**
 * The main column. P6-1 gives it its frame and a heading for the current selection; the
 * briefing (P6-2) and the file view (P6-3, `diff/FileView.tsx`) fill it.
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { type FileActions, FileView } from "../diff/FileView.js";
import type { Selection } from "./Sidebar.js";

type Props = {
  selection: Selection;
  analysis: AnalysisDocument | null;
  /** P6-3: the file view's viewed state and navigation. */
  files: FileActions;
};

export const MainContent = ({ selection, analysis, files }: Props) => (
  <article className={selection.kind === "file" ? "card file-card" : "card"}>
    {selection.kind === "briefing" ? (
      <div className="section">
        <div className="h-eyebrow">
          <span className="ai-tag">AI briefing</span>
          {analysis !== null && (
            <span>· est. ~{analysis.briefing.estimatedReviewMinutes} min review</span>
          )}
        </div>
        <h2 className="main-title">Briefing &amp; change map</h2>
        <p className="placeholder">
          {analysis === null
            ? "The analysis for this pull request is not ready yet."
            : "The summary, risk verdict and change map appear here."}
        </p>
      </div>
    ) : analysis === null ? (
      <div className="section">
        <p className="placeholder">The analysis for this pull request is not ready yet.</p>
      </div>
    ) : (
      <FileView path={selection.path} analysis={analysis} {...files} />
    )}
  </article>
);
