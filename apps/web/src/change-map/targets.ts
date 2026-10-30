/**
 * Change-map click-through (P5-3, ADR 0028): what a card or a badge opens. The map carries
 * `data-node` and `data-findings`, which are model output (schema ids, but chosen by the model
 * and readable in the DOM by anything else on the page). They are never used to build a URL,
 * selector or path: each is looked up in the document's own nodes and findings, and the file it
 * leads to must be one of the pull request's changed files. Anything else resolves to nothing.
 */
import type { AnalysisDocument } from "@rocky-reviews/schema";

export type MapTarget =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "finding"; readonly path: string; readonly line: number };

export type MapTargets = {
  /** The PR file a card opens: its first file reference that is in the PR. */
  node: (id: string) => MapTarget | undefined;
  /**
   * A badge lists its findings worst first; it opens the first. Every id must be one of the
   * document's findings, or the badge opens nothing (a list that is partly unknown was not
   * written by the renderer).
   */
  findings: (ids: string) => MapTarget | undefined;
  /** The PR's changed files, for the renderer's `interactive` option. */
  files: readonly string[];
};

export const mapTargets = (doc: AnalysisDocument): MapTargets => {
  const files = doc.provenance.files.map((file) => file.path);
  const prFiles = new Set(files);
  // Maps, not objects: an id like `__proto__` or `constructor` finds nothing.
  const nodes = new Map((doc.graph?.nodes ?? []).map((node) => [node.id, node]));
  const findings = new Map(doc.findings.map((finding) => [finding.id, finding]));
  return {
    files,
    node: (id) => {
      const path = nodes.get(id)?.files.find((ref) => prFiles.has(ref.path))?.path;
      return path === undefined ? undefined : { kind: "file", path };
    },
    findings: (ids) => {
      const list = ids.split(" ").map((id) => findings.get(id));
      const first = list[0];
      if (first === undefined || list.some((finding) => finding === undefined)) return undefined;
      if (!prFiles.has(first.path)) return undefined;
      return { kind: "finding", path: first.path, line: first.range.start };
    },
  };
};

/**
 * The target under a click or key press inside the map: the nearest badge or card ancestor of
 * the event's target (a badge is checked first: it is drawn over its card), read through
 * `dataset` only and never past the map's own root.
 */
export const targetAt = (
  root: Element,
  target: EventTarget | null,
  targets: MapTargets,
): MapTarget | undefined => {
  if (!(target instanceof Element) || !root.contains(target)) return undefined;
  const hit = target.closest("[data-findings], [data-node]");
  if (!(hit instanceof SVGElement) || !root.contains(hit)) return undefined;
  const { findings, node } = hit.dataset;
  if (findings !== undefined) return targets.findings(findings);
  if (node !== undefined) return targets.node(node);
  return undefined;
};
