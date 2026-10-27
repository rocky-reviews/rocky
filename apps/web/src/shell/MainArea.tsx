/**
 * The main column. P6-1 gives it its frame and a heading for the current selection; the
 * briefing (P6-2) and the file view (P6-3) fill it.
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";
import type { Selection } from "./Sidebar.js";

type Props = { selection: Selection; analysis: AnalysisDocument | null };

export const MainContent = ({ selection, analysis }: Props) => (
  <article className="card">
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
    ) : (
      <div className="section">
        <div className="h-eyebrow">File</div>
        <h2 className="main-title file-path">{selection.path}</h2>
        <p className="placeholder">The diff for this file appears here.</p>
      </div>
    )}
  </article>
);
