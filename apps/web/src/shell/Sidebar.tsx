/**
 * The triage sidebar (POC `renderSidebar`): review coverage, the briefing entry, files grouped
 * by risk level with a viewed checkbox, severity dots and the risk score, and the noise group.
 */
import { type ReactNode, useState } from "react";
import type { Severity } from "@rocky-reviews/schema";
import {
  type Coverage,
  LEVEL_LABEL,
  type NoiseGroup,
  type SidebarFile,
  type SidebarGroup,
} from "./triage-model.js";

export type Selection = { kind: "briefing" } | { kind: "file"; path: string };

type Props = {
  groups: readonly SidebarGroup[];
  noise: NoiseGroup;
  coverage: Coverage;
  selection: Selection;
  viewed: ReadonlySet<string>;
  onSelect: (selection: Selection) => void;
  onToggleViewed: (path: string) => void;
  onMarkViewed: (paths: readonly string[]) => void;
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

const isSelected = (selection: Selection, path: string): boolean =>
  selection.kind === "file" && selection.path === path;

export const SidebarContent = ({
  groups,
  noise,
  coverage,
  selection,
  viewed,
  onSelect,
  onToggleViewed,
  onMarkViewed,
}: Props) => {
  const [noiseOpen, setNoiseOpen] = useState(false);
  // "Show" and "Trust" replace the box that held focus; hand it to the first noise file.
  const [focusNoise, setFocusNoise] = useState(false);
  const focusFirst = (list: HTMLUListElement | null) => {
    if (list === null || !focusNoise) return;
    list.querySelector<HTMLButtonElement>(".nav-file")?.focus();
    setFocusNoise(false);
  };
  const noiseViewed = noise.files.length > 0 && noise.files.every((f) => viewed.has(f.path));
  const percent =
    coverage.total === 0 ? 100 : Math.round((coverage.reviewed / coverage.total) * 100);

  return (
    <>
      <section className="coverage" aria-label="Review coverage">
        <div className="coverage-top">
          <span id="coverage-label">Critical + Important reviewed</span>
          <b>
            {coverage.reviewed}/{coverage.total}
          </b>
        </div>
        <div
          className="bar"
          role="progressbar"
          aria-labelledby="coverage-label"
          aria-valuemin={0}
          aria-valuemax={coverage.total}
          aria-valuenow={coverage.reviewed}
        >
          <div style={{ width: `${percent}%` }} />
        </div>
        <div className="coverage-note">
          {coverage.done
            ? "All high-risk files reviewed ✓"
            : `About ${coverage.minutesLeft} min of high-risk code left`}
        </div>
      </section>

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

      {groups.map((group) => (
        <section key={group.level} aria-labelledby={`group-${group.level}`}>
          <h2 className="group-label" id={`group-${group.level}`}>
            <span>{LEVEL_LABEL[group.level]}</span>
            <Count n={group.files.length} />
          </h2>
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
                        <span key={f.id} className={`dot ${f.severity}`} />
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
        </section>
      ))}

      {noise.files.length > 0 && (
        <section aria-labelledby="group-noise">
          <h2 className="group-label" id="group-noise">
            <span>Noise · auto-summarized</span>
            <Count n={noise.files.length} />
          </h2>
          {noiseOpen || noiseViewed ? (
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
          )}
        </section>
      )}
    </>
  );
};

type RowProps = {
  path: string;
  level: SidebarFile["level"];
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
