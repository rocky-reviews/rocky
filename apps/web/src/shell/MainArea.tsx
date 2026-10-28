/**
 * The main column: the briefing (P6-2, `src/briefing/`) or the selected file (P6-3,
 * `diff/FileView.tsx`).
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";
import type { AnalysisRun } from "../briefing/analysis-run.js";
import { BriefingView } from "../briefing/Briefing.js";
import { type FileActions, FileView } from "../diff/FileView.js";
import type { Selection } from "./Sidebar.js";

type Props = {
  selection: Selection;
  analysis: AnalysisDocument | null;
  run: AnalysisRun;
  headSha: string;
  /** Opens a file from the briefing: selects it in the shell, like the sidebar does. */
  onOpenFile: (path: string) => void;
  /** P6-3: the file view's viewed state and navigation. */
  files: FileActions;
};

export const MainContent = ({ selection, analysis, run, headSha, onOpenFile, files }: Props) =>
  selection.kind === "briefing" ? (
    <BriefingView analysis={analysis} run={run} headSha={headSha} onOpenFile={onOpenFile} />
  ) : (
    <article className="card file-card">
      {analysis === null ? (
        <div className="section">
          <p className="placeholder">The analysis for this pull request is not ready yet.</p>
        </div>
      ) : (
        <FileView path={selection.path} analysis={analysis} {...files} />
      )}
    </article>
  );
