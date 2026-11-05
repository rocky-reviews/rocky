/**
 * The briefing (P6-2, POC `renderBrief`): the risk verdict and the TL;DR (H4-8; an older
 * document's summary paragraph instead), the files by risk (H4-10: a chip per level, the
 * selected level's files clickable below), the change map slot, project memory applied and what
 * the AI checked. H4-11 removed the suggested review path section; the document's review path
 * still orders "Start with the riskiest file", k and j. Without a document it shows where the
 * analysis stands instead (`BriefingState`).
 *
 * Everything from the document is untrusted text: model prose goes through `InlineText`, paths
 * and labels sit in `<bdi>`, and the fixed text for pipeline reasons comes from briefing-model.
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";
import { type KeyboardEvent, useRef, useState } from "react";
import type { AnalysisRun } from "./analysis-run.js";
import {
  type Banner,
  BRIEFING_REASON,
  briefingBanner,
  briefingLead,
  failureText,
  nameOf,
  readByHand,
  type RiskChoice,
  type RiskLevelGroup,
  type RiskLevelKey,
  riskLevels,
  selectedRiskLevel,
  startFile,
  tabKeyTarget,
  tokensText,
  VERDICT_LABEL,
} from "./briefing-model.js";
import { reviewOrder } from "../diff/annotations.js";
import { Kbd, useKeyShortcut } from "../keyboard/KeyboardContext.js";
import { ChangeMapSlot } from "./ChangeMap.js";
import { InlineText } from "./inline-text.js";

type Props = {
  analysis: AnalysisDocument | null;
  run: AnalysisRun;
  /** The PR's current head commit (GitHub's), to tell an out-of-date document. */
  headSha: string;
  /**
   * Selects the file in the shell (sidebar and main), as a sidebar click does; with a line
   * (a finding badge on the change map, P5-3), the diff opens focused on that line.
   */
  onOpenFile: (path: string, line?: number) => void;
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
  onOpenFile: (p: string, line?: number) => void;
}) => {
  const { briefing, provenance } = doc;
  const fallback = provenance.briefingUnavailable;
  const name = nameOf(doc);
  const byHand = readByHand(doc);
  const start = startFile(doc);
  // P6-5: k opens the first file in review order; the hint shows only when that is this file.
  const startKey = useKeyShortcut(start !== undefined && reviewOrder(doc)[0] === start ? "k" : "");
  const lead = briefingLead(doc);

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
          </div>
          <Title />
          {banner !== undefined && <BannerBox banner={banner} />}
          {fallback !== undefined && (
            <p className="brief-notice">
              <b>AI briefing unavailable:</b> {BRIEFING_REASON[fallback.reason]}.
            </p>
          )}
          {lead.kind === "tldr" ? (
            <>
              <VerdictBox verdict={briefing.verdict} />
              <div className="brief-tldr">
                <h3 className="h-eyebrow" id="tldr-title">
                  TL;DR
                </h3>
                <ul className="tldr-list" aria-labelledby="tldr-title">
                  {lead.items.map((item, i) => (
                    <li key={i}>
                      <InlineText text={item} />
                    </li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <>
              <p className="brief-summary">
                <InlineText text={lead.text} />
              </p>
              <VerdictBox verdict={briefing.verdict} />
            </>
          )}
          <RiskLevels
            head={doc.provenance.head.sha}
            levels={riskLevels(doc)}
            onOpenFile={onOpenFile}
          />
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
            aria-keyshortcuts={startKey || undefined}
            onClick={() => onOpenFile(start)}
          >
            Start with the riskiest file {startKey && <Kbd k={startKey} on />}
          </button>
        </div>
      )}
    </>
  );
};

/** The risk call: the level as a label on its tint, and the model's one-line reason. */
const VerdictBox = ({ verdict }: { verdict: AnalysisDocument["briefing"]["verdict"] }) => (
  <div className={`verdict v-${verdict.level}`}>
    <p className="verdict-level">{VERDICT_LABEL[verdict.level]}</p>
    <p className="verdict-reason">
      <InlineText text={verdict.reason} />
    </p>
  </div>
);

/**
 * H4-10: the files by risk as count chips, a WAI-ARIA tab list (selection follows focus), over
 * one panel with the selected level's files. The selection is component state, kept with the
 * head commit it was made on, so a new document starts on its default level.
 */
const RiskLevels = ({
  head,
  levels,
  onOpenFile,
}: {
  head: string;
  levels: RiskLevelGroup[];
  onOpenFile: (p: string) => void;
}) => {
  const [choice, setChoice] = useState<RiskChoice>();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  tabs.current.length = levels.length;
  const selected = selectedRiskLevel(levels, head, choice);
  const choose = (key: RiskLevelKey) => setChoice({ head, key });

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = tabKeyTarget(levels.length, index, e.key);
    const level = target === undefined ? undefined : levels[target];
    if (target === undefined || level === undefined) return;
    e.preventDefault();
    choose(level.key);
    tabs.current[target]?.focus();
  };

  return (
    <div className="risk-levels">
      <h3 className="h-eyebrow" id="risk-title">
        Files by risk
      </h3>
      {selected === undefined ? (
        <p className="empty-note">No files to show.</p>
      ) : (
        <>
          <div className="risk-chips" role="tablist" aria-labelledby="risk-title">
            {levels.map((level, index) => {
              const on = level.key === selected.key;
              return (
                <button
                  type="button"
                  role="tab"
                  key={level.key}
                  id={`risk-tab-${level.key}`}
                  className={`risk-chip r-${level.key}`}
                  aria-selected={on}
                  aria-controls="risk-panel"
                  tabIndex={on ? 0 : -1}
                  ref={(el) => {
                    tabs.current[index] = el;
                  }}
                  onClick={() => choose(level.key)}
                  onKeyDown={(e) => onKeyDown(e, index)}
                >
                  <span className="risk-dot" aria-hidden="true" />
                  {level.label} <b>{level.files.length}</b>
                  <span className="sr-only">{level.files.length === 1 ? " file" : " files"}</span>
                </button>
              );
            })}
          </div>
          <div
            className="risk-files"
            role="tabpanel"
            id="risk-panel"
            aria-labelledby={`risk-tab-${selected.key}`}
          >
            {selected.files.map((file, i) => (
              <span key={file.path} className="file-item">
                <FileButton path={file.path} name={file.name} onOpen={onOpenFile} />
                {i < selected.files.length - 1 && ", "}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
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
