/**
 * One finding project memory hid (P8-2b, `document.hidden`, schema 1.6), shown when the reviewer
 * expands "N findings hidden by memory" on a file: the AI mark, severity and confidence, the
 * title and body, the dismissal that hid it (where the team took it and why), and "Restore as a
 * draft", which brings it into the drafts at its line, undecided. Nothing here is posted or
 * decided: a hidden finding is not a draft until restored. Every string is text: the finding is
 * model output about PR content, the entry is stored text.
 */
import type { HiddenFinding } from "@rocky-reviews/schema";
import { Prose } from "../diff/Prose.js";
import { DISMISSED_AS, SEVERITY_LABEL } from "./DraftCard.js";
import { useReview } from "./ReviewProvider.js";

type Props = {
  hidden: HiddenFinding;
};

export const HiddenCard = ({ hidden }: Props) => {
  const { status, saving, restore } = useReview();
  const titleId = `hidden-${hidden.id}-title`;
  const busy = saving.has(hidden.id);
  const { hiddenBy } = hidden;
  return (
    <article
      className={`draft hidden-draft sev-${hidden.severity}`}
      id={`hidden-${hidden.id}`}
      data-hidden={hidden.id}
      aria-labelledby={titleId}
      aria-busy={busy}
      tabIndex={-1}
    >
      <div className="draft-head">
        <span className="ai-tag">AI finding</span>
        <span className={`sev ${hidden.severity}`}>{SEVERITY_LABEL[hidden.severity]}</span>
        <span className="conf">{hidden.confidence}% confident</span>
        <span className="spacer" />
        <span className="private-note">Hidden by project memory</span>
      </div>
      <h3 className="draft-title" id={titleId}>
        <bdi>{hidden.title}</bdi>
      </h3>
      <p className="draft-body">
        <bdi>
          <Prose text={hidden.body} />
        </bdi>
      </p>
      <p className="evidence hidden-by">
        <span className="mark" aria-hidden="true">
          ◆
        </span>
        <span>
          Your team dismissed this as {DISMISSED_AS[hiddenBy.dismissedAs]} on{" "}
          <code>
            <bdi>{hiddenBy.path}</bdi>
          </code>{" "}
          <span className="source">· {hiddenBy.entry.source}</span>, so Rocky did not draft it here.
        </span>
      </p>
      {status === "ready" ? (
        <div className="draft-actions">
          <button
            type="button"
            className="btn btn-sm"
            data-role="restore"
            disabled={busy}
            onClick={() => void restore(hidden)}
          >
            Restore as a draft
          </button>
          <span className="private-note">Restored, it is yours to accept, edit or dismiss.</span>
        </div>
      ) : (
        <p className="draft-actions locked-note">
          {status === "failed"
            ? "Your decisions could not be loaded, so this finding cannot be restored. Reload the page to try again."
            : "Loading your decisions…"}
        </p>
      )}
    </article>
  );
};
