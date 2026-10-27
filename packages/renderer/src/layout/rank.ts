/**
 * Layer index per node.
 *
 * Adapted from PR Lens (https://github.com/coldteadotai/pr-lens, packages/renderer/src/layout/
 * rank.ts at 918ffe82cb1dd71d20ce70b27917aeb80a7a4b49), MIT License, Copyright (c) 2026
 * Coldtea AI. See NOTICE. Changes: no layout hints (Rocky's schema has none).
 */
import type { GraphEdge, GraphNode } from "@rocky-reviews/schema";

/**
 * Longest path from a source, so an arrow points at a node below the one it left. Real
 * dependency graphs contain cycles, and a cycle has no such ordering, so the edges that close
 * one are dropped first: the arrow is still drawn, it just runs back up the page.
 */
export const rankNodes = (
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Map<string, number> => {
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const node of nodes) {
    forward.set(node.id, []);
    backward.set(node.id, []);
  }

  const withinGraph = edges.filter(
    (edge) => edge.from !== edge.to && forward.has(edge.from) && forward.has(edge.to),
  );
  for (const edge of withinGraph) forward.get(edge.from)?.push(edge.to);

  for (const [from, to] of forwardEdgesWithoutCycles(nodes, forward)) backward.get(to)?.push(from);

  // Iterative, in document order: a 256-deep chain must not depend on the call stack.
  const ranks = new Map<string, number>();
  for (const root of nodes) {
    const stack: string[] = [root.id];
    while (stack.length > 0) {
      const id = stack[stack.length - 1] ?? "";
      if (ranks.has(id)) {
        stack.pop();
        continue;
      }
      const pending = (backward.get(id) ?? []).filter((predecessor) => !ranks.has(predecessor));
      if (pending.length > 0) {
        stack.push(...pending.reverse());
        continue;
      }
      let rank = 0;
      for (const predecessor of backward.get(id) ?? [])
        rank = Math.max(rank, (ranks.get(predecessor) ?? 0) + 1);
      ranks.set(id, rank);
      stack.pop();
    }
  }
  return ranks;
};

/**
 * Depth-first from every node in document order, dropping any edge that reaches a node still
 * open on the stack. Which edge closes a cycle depends on where the walk started, so the walk
 * order is fixed by the document rather than by iteration order of a map.
 */
const forwardEdgesWithoutCycles = (
  nodes: readonly GraphNode[],
  forward: ReadonlyMap<string, readonly string[]>,
): [string, string][] => {
  const kept: [string, string][] = [];
  const open = new Set<string>();
  const closed = new Set<string>();

  for (const root of nodes) {
    if (closed.has(root.id)) continue;

    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    open.add(root.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) break;

      const successors = forward.get(frame.id) ?? [];
      if (frame.next >= successors.length) {
        open.delete(frame.id);
        closed.add(frame.id);
        stack.pop();
        continue;
      }

      const successor = successors[frame.next];
      frame.next += 1;
      if (successor === undefined || open.has(successor)) continue;

      kept.push([frame.id, successor]);
      if (closed.has(successor)) continue;

      open.add(successor);
      stack.push({ id: successor, next: 0 });
    }
  }

  return kept;
};
