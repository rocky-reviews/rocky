/**
 * Finding badges: which findings a card stands for, and how bad the worst one is.
 *
 * A finding belongs to a card when the card is backed by the finding's file and, if the card's
 * file reference names lines, the finding's lines overlap them. A file behind two cards counts
 * on both. The caller passes the findings to draw, so the briefing can leave out the dismissed
 * ones (as the POC does) without the renderer knowing about review state.
 */
import type { Finding, GraphNode, Severity } from "@rocky-reviews/schema";

export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];

const rankOf = (severity: Severity): number => SEVERITY_ORDER.indexOf(severity);

export type NodeFindings = {
  /** Worst first, then in document order. */
  findings: Finding[];
  worst: Severity;
};

const backs = (node: GraphNode, finding: Finding): boolean =>
  node.files.some(
    (ref) =>
      ref.path === finding.path &&
      (ref.range === undefined ||
        (finding.range.start <= ref.range.end && ref.range.start <= finding.range.end)),
  );

export const findingsFor = (
  node: GraphNode,
  findings: readonly Finding[],
): NodeFindings | undefined => {
  const mine = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => backs(node, finding))
    .sort((a, b) => rankOf(a.finding.severity) - rankOf(b.finding.severity) || a.index - b.index)
    .map(({ finding }) => finding);
  const worst = mine[0];
  return worst === undefined ? undefined : { findings: mine, worst: worst.severity };
};
