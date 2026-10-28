/**
 * The change map's place in the briefing (P6-2): heading, hint, legend and the unavailable
 * state are page HTML here. The map itself is `ChangeMapCanvas`, the one seam for the renderer
 * (P5-1) once its SVG can be put in the page safely (P5-2): replace that component's body and
 * nothing else. Until then it lays the graph's lanes and cards out as plain HTML, with no edges.
 */
import type { AnalysisDocument, Graph, Severity } from "@rocky-reviews/schema";
import { graphState } from "./briefing-model.js";

type Props = { doc: AnalysisDocument; onOpenFile: (path: string) => void };

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const ChangeMapSlot = ({ doc, onOpenFile }: Props) => {
  const state = graphState(doc);
  return (
    <section className="section" aria-labelledby="change-map-title">
      <h3 className="h-eyebrow" id="change-map-title">
        Change map
        {state.kind === "drawn" && (
          <span className="eyebrow-hint">· click a card to open its file</span>
        )}
      </h3>
      {doc.graph !== undefined ? (
        <>
          <ChangeMapCanvas graph={doc.graph} doc={doc} onOpenFile={onOpenFile} />
          <ul className="legend" aria-label="Legend">
            <li className="lg-add">New in this PR</li>
            <li className="lg-mod">Changed</li>
            <li className="lg-unch">Existing, untouched</li>
            <li className="lg-hero">Where the change matters</li>
            <li className="lg-find">Open findings</li>
          </ul>
        </>
      ) : (
        <div className="map-unavailable">
          <p className="map-unavailable-title">Change map unavailable</p>
          {state.kind === "unavailable" && state.reason !== undefined && <p>{state.reason}</p>}
          {state.kind === "unavailable" && state.detail !== undefined && (
            <p>
              <bdi>{state.detail}</bdi>
            </p>
          )}
          <p className="map-unavailable-note">The rest of the briefing is complete without it.</p>
        </div>
      )}
    </section>
  );
};

type CanvasProps = { graph: Graph; doc: AnalysisDocument; onOpenFile: (path: string) => void };

/**
 * The seam for the renderer (P5-1/P5-2). Today: lanes in order, each card a button when it
 * backs a file in this PR, with the worst open finding's severity and count.
 */
export const ChangeMapCanvas = ({ graph, doc, onOpenFile }: CanvasProps) => {
  const prFiles = new Set(doc.provenance.files.map((f) => f.path));
  const findings = (path: string) =>
    doc.findings
      .filter((f) => f.path === path)
      .toSorted((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const lanes = graph.lanes
    .map((lane, index) => ({ lane, index }))
    .toSorted((a, b) => (a.lane.order ?? a.index) - (b.lane.order ?? b.index) || a.index - b.index);

  return (
    <div className="map-canvas">
      {lanes.map(({ lane }) => (
        <section key={lane.id} className="map-lane" aria-label={`Lane ${lane.label}`}>
          <h4 className="map-lane-label">
            <bdi>{lane.label}</bdi>
          </h4>
          <ul className="map-cards">
            {graph.nodes
              .filter((node) => node.lane === lane.id)
              .map((node) => {
                const file = node.files.find((f) => prFiles.has(f.path))?.path;
                const found = file === undefined ? [] : findings(file);
                const body = (
                  <>
                    <span className="map-card-title">
                      <bdi>{node.label}</bdi>
                    </span>
                    {node.subtitle !== undefined && (
                      <span className="map-card-sub">
                        <bdi>{node.subtitle}</bdi>
                      </span>
                    )}
                    {found[0] !== undefined && (
                      <span className={`map-badge sev-${found[0].severity}`}>
                        <span aria-hidden="true">{found.length}</span>
                        <span className="sr-only">
                          , {found.length} {found.length === 1 ? "finding" : "findings"}, worst{" "}
                          {found[0].severity}
                        </span>
                      </span>
                    )}
                  </>
                );
                return (
                  <li key={node.id} className={`map-card d-${node.delta}`}>
                    {file === undefined ? (
                      <div className="map-card-body">{body}</div>
                    ) : (
                      <button
                        type="button"
                        className="map-card-body"
                        data-path={file}
                        onClick={() => onOpenFile(file)}
                      >
                        {body}
                        <span className="sr-only">
                          , opens <bdi>{file}</bdi>
                        </span>
                      </button>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
};
