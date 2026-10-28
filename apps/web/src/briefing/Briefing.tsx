/**
 * The briefing (P6-2, POC `renderBrief`): summary and risk verdict, the risk table with
 * clickable files, the change map slot, the suggested path, project memory applied and what the
 * AI checked. Without a document it shows where the analysis stands instead (`BriefingState`).
 *
 * Everything from the document is untrusted text: model prose goes through `InlineText`, paths
 * and labels sit in `<bdi>`, and the fixed text for pipeline reasons comes from briefing-model.
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";
import type { AnalysisRun } from "./analysis-run.js";
import {
  type Banner,
  BRIEFING_REASON,
  briefingBanner,
  failureText,
  nameOf,
  readByHand,
  reviewPathRows,
  riskRows,
  startFile,
  tokensText,
  VERDICT_LABEL,
} from "./briefing-model.js";
import { ChangeMapSlot } from "./ChangeMap.js";
import { InlineText } from "./inline-text.js";

type Props = {
  analysis: AnalysisDocument | null;
  run: AnalysisRun;
  /** The PR's current head commit (GitHub's), to tell an out-of-date document. */
  headSha: string;
  /** Selects the file in the shell (sidebar and main), as a sidebar click does. */
  onOpenFile: (path: string) => void;
};

export const BriefingView = ({ analysis, run, headSha, onOpenFile }: Props) =>
  analysis === null ? (
    <BriefingState run={run.status === "done" ? { status: "none" } : run} />
  ) : (
    <Briefing
      doc={analysis}
      banner={briefingBanner(run, analysis.provenance.head.sha, headSha)}
      onOpenFile={onOpenFile}
    />
  );

/** Over a document that is not the latest word: a newer run, or another commit than the head. */
const BannerBox = ({ banner }: { banner: Banner }) => (
  <div className={`brief-banner tone-${banner.tone}`} role={banner.live ? "status" : undefined}>
    <p className="brief-banner-title">{banner.title}</p>
    <p>{banner.detail}</p>
    {banner.code !== undefined && (
      <p className="brief-state-code">
        Code: <code>{banner.code}</code>
      </p>
    )}
  </div>
);

const Title = () => (
  <h2 className="main-title" id="briefing-title">
    Briefing &amp; change map
  </h2>
);

const Briefing = ({
  doc,
  banner,
  onOpenFile,
}: {
  doc: AnalysisDocument;
  banner: Banner | undefined;
  onOpenFile: (p: string) => void;
}) => {
  const { briefing, provenance } = doc;
  const fallback = provenance.briefingUnavailable;
  const name = nameOf(doc);
  const byHand = readByHand(doc);
  const path = reviewPathRows(doc);
  const start = startFile(doc);
  const minutes = `est. ~${briefing.estimatedReviewMinutes} min review`;

  return (
    <>
      <article className="card brief" aria-labelledby="briefing-title">
        <section className="section">
          <div className="h-eyebrow">
            {fallback === undefined ? (
              <span className="ai-tag">AI briefing</span>
            ) : (
              <span>Briefing by Rocky</span>
            )}
            <span>· {minutes}</span>
          </div>
          <Title />
          {banner !== undefined && <BannerBox banner={banner} />}
          {fallback !== undefined && (
            <p className="brief-notice">
              <b>AI briefing unavailable:</b> {BRIEFING_REASON[fallback.reason]}.
            </p>
          )}
          <p className="brief-summary">
            <InlineText text={briefing.summary} />
          </p>
          <div className={`verdict v-${briefing.verdict.level}`}>
            <p className="verdict-level">{VERDICT_LABEL[briefing.verdict.level]}</p>
            <p className="verdict-reason">
              <InlineText text={briefing.verdict.reason} />
            </p>
          </div>
          <table className="risk-table">
            <caption className="sr-only">Files by risk</caption>
            <tbody>
              {riskRows(doc).map((row) => (
                <tr key={row.key} className={`rt-${row.key}`}>
                  <th scope="row" className="rt-label">
                    <span className={`risk-label r-${row.key}`}>{row.label}</span>
                  </th>
                  <td className="rt-text">
                    <b>{row.text}</b>
                  </td>
                  <td className="rt-files">
                    {row.files.map((file, i) => (
                      <span key={file.path} className="file-item">
                        <FileButton path={file.path} name={file.name} onOpen={onOpenFile} />
                        {i < row.files.length - 1 && ", "}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {byHand.length > 0 && (
            <p className="read-by-hand">
              <b>Read by hand:</b> the AI reviewed these risky files and drafted nothing.{" "}
              {byHand.map((p, i) => (
                <span key={p} className="file-item">
                  <FileButton path={p} name={name(p)} onOpen={onOpenFile} />
                  {i < byHand.length - 1 && ", "}
                </span>
              ))}
            </p>
          )}
        </section>

        <ChangeMapSlot doc={doc} onOpenFile={onOpenFile} />

        <section className="section" aria-labelledby="path-title">
          <h3 className="h-eyebrow" id="path-title">
            Suggested review path
          </h3>
          {path.length === 0 ? (
            <p className="empty-note">No suggested order for this pull request.</p>
          ) : (
            <ol className="path-list">
              {path.map((step) => (
                <li key={step.path}>
                  <button
                    type="button"
                    className={`r-${step.level}`}
                    data-path={step.path}
                    onClick={() => onOpenFile(step.path)}
                  >
                    <span className="path-text">
                      <code>
                        <bdi>{step.path}</bdi>
                      </code>
                      <span className="why">
                        <InlineText text={step.why} />
                      </span>
                    </span>
                    <span className="score">
                      <span className="sr-only">risk score </span>
                      {step.score}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="section two">
          <div>
            <h3 className="h-eyebrow" id="memory-title">
              Project memory applied
            </h3>
            {briefing.memoryApplied.length === 0 ? (
              <p className="empty-note">
                {fallback === undefined
                  ? "No project memory was applied."
                  : "Not available without the AI briefing."}
              </p>
            ) : (
              <ul className="mini-list" aria-labelledby="memory-title">
                {briefing.memoryApplied.map((m) => (
                  <li key={m.entryId}>
                    <span className="ic memory" aria-hidden="true" />
                    <span>
                      <InlineText text={m.text} />{" "}
                      <span className="source">
                        · <bdi>{m.source}</bdi>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="h-eyebrow" id="checked-title">
              AI checked, looks fine
            </h3>
            {briefing.checkedOk.length === 0 ? (
              <p className="empty-note">
                {fallback === undefined
                  ? "The AI listed nothing it checked."
                  : "Not available without the AI briefing."}
              </p>
            ) : (
              <ul className="mini-list" aria-labelledby="checked-title">
                {briefing.checkedOk.map((item, i) => (
                  <li key={i}>
                    <span className="ic ok" aria-hidden="true" />
                    <span>
                      <InlineText text={item} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </article>
      {start !== undefined && (
        <div className="brief-start">
          <button
            type="button"
            className="btn btn-primary"
            data-path={start}
            onClick={() => onOpenFile(start)}
          >
            Start with the riskiest file
          </button>
        </div>
      )}
    </>
  );
};

const FileButton = ({
  path,
  name,
  onOpen,
}: {
  path: string;
  name: string;
  onOpen: (path: string) => void;
}) => (
  <button
    type="button"
    className="file-link"
    title={path}
    aria-label={`Open ${path}`}
    data-path={path}
    onClick={() => onOpen(path)}
  >
    <bdi>{name}</bdi>
  </button>
);

/** What the briefing says while there is no document: fixed text only. */
const BriefingState = ({ run }: { run: Exclude<AnalysisRun, { status: "done" }> }) => {
  const { tone, title, body, live } = stateText(run);
  return (
    <article className="card brief" aria-labelledby="briefing-title">
      <section className="section">
        <div className="h-eyebrow">
          <span className="ai-tag">AI briefing</span>
        </div>
        <Title />
        <div className={`brief-state tone-${tone}`} role={live ? "status" : undefined}>
          <p className="brief-state-title">{title}</p>
          {body.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {run.status === "failed" && run.code !== "superseded" && (
            <p className="brief-state-code">
              Code: <code>{run.code}</code>
            </p>
          )}
        </div>
      </section>
    </article>
  );
};

type StateText = {
  tone: "neutral" | "ai" | "warn" | "crit";
  title: string;
  body: string[];
  live: boolean;
};

const stateText = (run: Exclude<AnalysisRun, { status: "done" }>): StateText => {
  switch (run.status) {
    case "none":
      return {
        tone: "neutral",
        title: "No analysis yet",
        body: [
          "Rocky has not analysed this pull request yet. The briefing, risk table and change map appear here once it has.",
        ],
        live: false,
      };
    case "queued":
    case "running":
      return {
        tone: "ai",
        title: run.status === "queued" ? "Queued for analysis" : "Analysing this pull request",
        body: ["The briefing appears here when the analysis is done."],
        live: true,
      };
    case "awaiting_approval":
      return {
        tone: "warn",
        title: "Waiting for approval",
        body: [
          `This pull request needs ${tokensText(run.estimatedTokens, run.limitTokens)}.`,
          "Nothing has been sent to a model. Someone who manages Rocky for this organisation can approve the run.",
        ],
        live: false,
      };
    case "failed":
      return run.code === "superseded"
        ? {
            tone: "neutral",
            title: "Analysis out of date",
            body: [
              "A newer commit was pushed or the pull request was closed before this analysis finished. Rocky analyses the latest commit of an open pull request.",
            ],
            live: false,
          }
        : {
            tone: "crit",
            title: "Analysis failed",
            body: [failureText(run.code)],
            live: false,
          };
  }
};
