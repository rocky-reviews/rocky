/**
 * The main column: the briefing (P6-2, `src/briefing/`) or the selected file (P6-3).
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";
import type { AnalysisRun } from "../briefing/analysis-run.js";
import { BriefingView } from "../briefing/Briefing.js";
import type { Selection } from "./Sidebar.js";

type Props = {
  selection: Selection;
  analysis: AnalysisDocument | null;
  run: AnalysisRun;
  headSha: string;
  /** Opens a file from the briefing: selects it in the shell, like the sidebar does. */
  onOpenFile: (path: string) => void;
};

export const MainContent = ({ selection, analysis, run, headSha, onOpenFile }: Props) =>
  selection.kind === "briefing" ? (
    <BriefingView analysis={analysis} run={run} headSha={headSha} onOpenFile={onOpenFile} />
  ) : (
    <article className="card">
      <div className="section">
        <div className="h-eyebrow">File</div>
        <h2 className="main-title file-path">
          <bdi>{selection.path}</bdi>
        </h2>
        <p className="placeholder">The diff for this file appears here.</p>
      </div>
    </article>
  );
