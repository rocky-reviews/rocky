/**
 * The triage sidebar (POC `renderSidebar`): review coverage, the briefing entry, files grouped
 * by risk level with a viewed checkbox, severity dots and the risk score, and the noise group.
 * H4-12: the Tree button under the coverage card opens the change tree (also `t`).
 */
import { type ReactNode, useState } from "react";
import type { Severity } from "@rocky-reviews/schema";
import { useReview } from "../drafts/ReviewProvider.js";
import { Kbd, useKeyShortcut } from "../keyboard/KeyboardContext.js";
import { FolderIcon } from "./icons.js";
import { isLowerRisk, hasHighRisk, readLowerRisk, saveLowerRisk } from "./lower-risk.js";
import { useToast } from "./Toast.js";
import {
  type Coverage,
  coverageNote,
  LEVEL_LABEL,
  type NoiseGroup,
  type SidebarFile,
  type SidebarGroup,
} from "./triage-model.js";

/** `line`: open the diff focused on that new-side line (a finding from the change map, P5-3). */
export type Selection =
  { kind: "briefing" } | { kind: "file"; path: string; line?: number | undefined };

type Props = {
  groups: readonly SidebarGroup[];
  noise: NoiseGroup;
  /** Files the AI could not analyse (P6-2): listed so they can be opened and marked viewed. */
  unanalysed?: readonly string[];
  coverage: Coverage;
  selection: Selection;
  viewed: ReadonlySet<string>;
  onSelect: (selection: Selection) => void;
  onToggleViewed: (path: string) => void;
  onMarkViewed: (paths: readonly string[]) => void;
  /** Where the lower-risk choice is kept; tests pass their own. */
  storage?: () => Storage;
  /** H4-12: opens the change tree. */
  onOpenTree?: (() => void) | undefined;
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

const findingsText = (findings: SidebarFile["findings"]): string => {
  if (findings.length === 0) return "no findings";
  const worst = findings[0]?.severity ?? "low";
  const n = findings.length;
  return `${n} ${n === 1 ? "finding" : "findings"}, worst ${SEVERITY_LABEL[worst]}`;
};

/** A group's file count: the number on screen, "n files" for screen readers. */
const Count = ({ n }: { n: number }) => (
  <span>
    <span aria-hidden="true">{n}</span>
    <span className="sr-only">
      {n} {n === 1 ? "file" : "files"}
    </span>
  </span>
);

const browserStorage = (): Storage => window.localStorage;

const isSelected = (selection: Selection, path: string): boolean =>
  selection.kind === "file" && selection.path === path;

export const SidebarContent = ({
  groups,
  noise,
  unanalysed = [],
  coverage,
  selection,
  viewed,
  onSelect,
  onToggleViewed,
  onMarkViewed,
  storage = browserStorage,
  onOpenTree,
}: Props) => {
  const treeKey = useKeyShortcut("t");
  const [noiseOpen, setNoiseOpen] = useState(false);
  const { decisionOf } = useReview();
  const toast = useToast();
  // "Show" and "Trust" replace the box that held focus; hand it to the first noise file.
  const [focusNoise, setFocusNoise] = useState(false);
  const focusFirst = (list: HTMLUListElement | null) => {
    if (list === null || !focusNoise) return;
    list.querySelector<HTMLButtonElement>(".nav-file")?.focus();
    setFocusNoise(false);
  };
  const noiseViewed = noise.files.length > 0 && noise.files.every((f) => viewed.has(f.path));
  // A noise file opened by k/j or "next" (P6-5) shows where it is in the list.
  const noiseSelected = noise.files.some((f) => isSelected(selection, f.path));
  const percent =
    coverage.total === 0 ? 100 : Math.round((coverage.reviewed / coverage.total) * 100);

  // H4-9: Normal, Low and noise sit behind one toggle, remembered per browser.
  const [lowerChoice, setLowerChoice] = useState(() => readLowerRisk(storage));
  const foldable = hasHighRisk(groups);
  const lowerShown = !foldable || (lowerChoice ?? false);
  const lowerGroups = groups.filter((g) => isLowerRisk(g.level));
  const lowerCount = lowerGroups.reduce((n, g) => n + g.files.length, 0) + noise.files.length;
  const lowerIds = [
    ...lowerGroups.map((g) => `section-${g.level}`),
    ...(noise.files.length > 0 ? ["section-noise"] : []),
  ];
  const renderGroup = (group: SidebarGroup) => (
    <section
      key={group.level}
      id={`section-${group.level}`}
      aria-labelledby={`group-${group.level}`}
    >
      <h2 className="group-label" id={`group-${group.level}`}>
        <span>{LEVEL_LABEL[group.level]}</span>
        <Count n={group.files.length} />
      </h2>
      {(!isLowerRisk(group.level) ||
        lowerShown ||
        group.files.some((f) => isSelected(selection, f.path))) && (
        <ul className="file-list">
          {group.files.map((file) => (
            <FileRow
              key={file.path}
              path={file.path}
              level={file.level}
              viewed={viewed.has(file.path)}
              selected={isSelected(selection, file.path)}
              onSelect={() => onSelect({ kind: "file", path: file.path })}
              onToggleViewed={() => onToggleViewed(file.path)}
              extra={
                <>
                  <span className="dots" aria-hidden="true">
                    {file.findings.map((f) => (
                      <span
                        key={f.id}
                        className={`dot ${f.severity}${decisionOf(f.id).state === "draft" ? "" : " done"}`}
                      />
                    ))}
                  </span>
                  <span className="score" aria-hidden="true">
                    {file.score}
                  </span>
                  <span className="sr-only">
                    , risk score {file.score}, {findingsText(file.findings)}
                  </span>
                </>
              }
            />
          ))}
        </ul>
      )}
    </section>
  );

  return (
    <>
      <section className="coverage" aria-label="Review coverage">
        <div className="coverage-top">
          <span id="coverage-label">Critical + Important reviewed</span>
          <b>
            {coverage.reviewed}/{coverage.total}
          </b>
        </div>
        {/* With nothing high-risk there is no range to report: the "0/0" says it (P6-8). */}
        <div
          className="bar"
          {...(coverage.total === 0
            ? { "aria-hidden": true }
            : {
                role: "progressbar",
                "aria-labelledby": "coverage-label",
                "aria-valuemin": 0,
                "aria-valuemax": coverage.total,
                "aria-valuenow": coverage.reviewed,
              })}
        >
          <div style={{ width: `${percent}%` }} />
        </div>
        <div className="coverage-note">{coverageNote(coverage)}</div>
      </section>

      {onOpenTree !== undefined && (
        // The t hint sits beside the button, not in it: its name "Change tree" must contain all
        // of its visible text (axe label-content-name-mismatch).
        <div className="tree-entry">
          <button
            type="button"
            className="btn btn-sm btn-ghost tree-btn"
            aria-label="Change tree"
            aria-haspopup="dialog"
            aria-keyshortcuts={treeKey}
            onClick={onOpenTree}
          >
            <FolderIcon />
            Tree
          </button>
          <Kbd k="t" />
        </div>
      )}

      <button
        type="button"
        className={`nav-item nav-brief${selection.kind === "briefing" ? " sel" : ""}`}
        aria-current={selection.kind === "briefing" ? "page" : undefined}
        onClick={() => onSelect({ kind: "briefing" })}
      >
        <span className="brief-icon" aria-hidden="true" />
        <span className="name">
          <span>Briefing &amp; change map</span>
        </span>
      </button>

      {groups.filter((g) => !isLowerRisk(g.level)).map(renderGroup)}

      {foldable && lowerCount > 0 && (
        <button
          type="button"
          className="lower-risk-toggle"
          aria-expanded={lowerShown}
          aria-controls={lowerIds.join(" ")}
          onClick={() => {
            const next = !lowerShown;
            saveLowerRisk(storage, next);
            setLowerChoice(next);
          }}
        >
          {lowerShown
            ? "Hide lower-risk files"
            : `Show ${lowerCount} lower-risk ${lowerCount === 1 ? "file" : "files"}`}
        </button>
      )}

      {groups.filter((g) => isLowerRisk(g.level)).map(renderGroup)}

      {unanalysed.length > 0 && (
        <section aria-labelledby="group-unanalysed">
          <h2 className="group-label" id="group-unanalysed">
            <span>Not analysed</span>
            <Count n={unanalysed.length} />
          </h2>
          <ul className="file-list">
            {unanalysed.map((path) => (
              <FileRow
                key={path}
                path={path}
                level="unanalysed"
                viewed={viewed.has(path)}
                selected={isSelected(selection, path)}
                onSelect={() => onSelect({ kind: "file", path })}
                onToggleViewed={() => onToggleViewed(path)}
              />
            ))}
          </ul>
        </section>
      )}

      {noise.files.length > 0 && (
        <section id="section-noise" aria-labelledby="group-noise">
          <h2 className="group-label" id="group-noise">
            <span>Noise · auto-summarized</span>
            <Count n={noise.files.length} />
          </h2>
          {(lowerShown || noiseSelected) &&
            (noiseOpen || noiseViewed || noiseSelected ? (
              <ul className="file-list" ref={focusFirst}>
                {noise.files.map((file) => (
                  <FileRow
                    key={file.path}
                    path={file.path}
                    level="low"
                    viewed={viewed.has(file.path)}
                    selected={isSelected(selection, file.path)}
                    onSelect={() => onSelect({ kind: "file", path: file.path })}
                    onToggleViewed={() => onToggleViewed(file.path)}
                  />
                ))}
              </ul>
            ) : (
              <div className="noise-box">
                {noise.files.length} {noise.files.length === 1 ? "file" : "files"} ({noise.lines}{" "}
                lines) the AI summarised as noise.
                <div className="noise-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setFocusNoise(true);
                      onMarkViewed(noise.files.map((f) => f.path));
                      const n = noise.files.length;
                      toast(
                        `${n} noise ${n === 1 ? "file" : "files"} marked viewed from the AI summary`,
                      );
                    }}
                  >
                    Trust &amp; mark viewed
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => {
                      setFocusNoise(true);
                      setNoiseOpen(true);
                    }}
                  >
                    Show
                  </button>
                </div>
              </div>
            ))}
        </section>
      )}
    </>
  );
};

type RowProps = {
  path: string;
  /** `unanalysed`: a file the AI could not analyse, which has no risk level. */
  level: SidebarFile["level"] | "unanalysed";
  viewed: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggleViewed: () => void;
  extra?: ReactNode;
};

/** A checkbox and a button side by side: two controls, never one nested in the other. */
const FileRow = ({ path, level, viewed, selected, onSelect, onToggleViewed, extra }: RowProps) => (
  <li className={`nav-item r-${level}${selected ? " sel" : ""}${viewed ? " viewed" : ""}`}>
    <input
      type="checkbox"
      className="check"
      checked={viewed}
      onChange={onToggleViewed}
      aria-label={`Viewed ${path}`}
    />
    <button
      type="button"
      className="nav-file"
      title={path}
      aria-current={selected ? "page" : undefined}
      onClick={onSelect}
    >
      <span className="name">
        <bdi>{path}</bdi>
      </span>
      {extra}
    </button>
  </li>
);
