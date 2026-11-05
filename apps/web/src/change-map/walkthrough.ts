/**
 * H4-6 (ADR 0035): the Guided walkthrough's logic, apart from React. The document's walkthrough
 * steps become stops on the change map: what each lights (a `MapFocus` for the renderer) and
 * where the map pans and zooms to show it.
 *
 * A step's stage is a drill-down view or one flow. The map has no separate pictures for those
 * yet, so a stop always plays over the whole map: a view's selection, or a flow's participants
 * and the edges between them, become the focus. Messages a step names light the graph edges
 * that join the same two nodes. Every id is looked up in the graph; unknown ones light nothing.
 */
import type { MapFocus } from "@rocky-reviews/renderer";
import type { Graph, View } from "@rocky-reviews/schema";

export type TourStop = {
  id: string;
  heading: string;
  body: string;
  /** What stays lit; `undefined` is the whole map (an overview stop). */
  focus: MapFocus | undefined;
};

const findView = (views: readonly View[], id: string): View | undefined => {
  for (const view of views) {
    if (view.id === id) return view;
    const child = findView(view.children, id);
    if (child !== undefined) return child;
  }
  return undefined;
};

/** The graph edges joining the same two nodes as a message, in either direction. */
const edgesBetween = (graph: Graph, from: string, to: string): string[] =>
  graph.edges
    .filter(
      (edge) => (edge.from === from && edge.to === to) || (edge.from === to && edge.to === from),
    )
    .map((edge) => edge.id);

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

const isEmpty = (focus: MapFocus): boolean =>
  focus.lanes.length + focus.nodes.length + focus.edges.length === 0;

export const tourStops = (graph: Graph): TourStop[] =>
  (graph.walkthrough?.steps ?? []).map((step) => {
    const stage = step.stage;
    const flow =
      stage?.kind === "flow"
        ? graph.flows.find((candidate) => candidate.id === stage.flow)
        : undefined;
    const view = stage?.kind === "view" ? findView(graph.views, stage.view) : undefined;
    let focus: MapFocus | undefined;
    if (step.focus.kind === "selection") {
      const messages = new Set(step.focus.messages);
      const named = (flow?.messages ?? []).filter((message) => messages.has(message.id));
      focus = {
        lanes: step.focus.lanes,
        nodes: unique([
          ...step.focus.nodes,
          ...named.flatMap((message) => [message.from, message.to]),
        ]),
        edges: unique([
          ...step.focus.edges,
          ...(flow === undefined
            ? []
            : named.flatMap((message) => edgesBetween(graph, message.from, message.to))),
        ]),
      };
    } else if (flow !== undefined) {
      const nodes = flow.participants.map((participant) => participant.node);
      focus = {
        lanes: [],
        nodes,
        edges: unique(
          flow.messages.flatMap((message) => edgesBetween(graph, message.from, message.to)),
        ),
      };
    } else if (view?.scope.kind === "selection") {
      focus = { lanes: view.scope.lanes, nodes: view.scope.nodes, edges: view.scope.edges };
    }
    return {
      id: step.id,
      heading: step.heading,
      body: step.body,
      focus: focus === undefined || isEmpty(focus) ? undefined : focus,
    };
  });

export const clampStop = (index: number, count: number): number =>
  Math.max(0, Math.min(count - 1, index));

// --- Pan and zoom --------------------------------------------------------------------------

export type Size = { width: number; height: number };
export type Box = { x: number; y: number; width: number; height: number };
export type Transform = { scale: number; x: number; y: number };

/** The stage never gets taller than this, nor shorter than the floor, whatever the map. */
export const STAGE_MAX_HEIGHT = 460;
export const STAGE_MIN_HEIGHT = 220;
/** Room kept around a focus, in stage pixels. */
const FOCUS_PADDING = 24;
/** A focus is never drawn larger than this (1 is the map's own size). */
export const MAX_ZOOM = 1.25;
/**
 * Nor smaller than the map's own size: on a narrow stage the focus stays legible (and its badges
 * keep their 24 px targets), centred, and may run past the stage's edges.
 */
export const MIN_FOCUS_ZOOM = 1;

/**
 * The stage for a map in a box `available` wide: the whole map fits at `base` scale (never
 * enlarged), and the stage is as tall as that, within its bounds.
 */
export const stageFor = (available: number, map: Size): Size & { base: number } => {
  const width = Math.max(1, available);
  const base = Math.min(1, width / map.width, STAGE_MAX_HEIGHT / map.height);
  const height = Math.round(
    Math.max(STAGE_MIN_HEIGHT, Math.min(STAGE_MAX_HEIGHT, map.height * base)),
  );
  return { width, height, base };
};

/** Keeps the map covering the stage on an axis where it is larger, centred where it is not. */
const place = (stage: number, drawn: number, wanted: number): number =>
  drawn <= stage ? (stage - drawn) / 2 : Math.min(0, Math.max(stage - drawn, wanted));

/**
 * Where the map sits for a stop: the whole map at `base` scale for an overview, otherwise
 * zoomed until the focus fills the stage (between the map's own size and MAX_ZOOM) and centred
 * on it.
 */
export const fitTransform = (
  stage: Size & { base: number },
  map: Size,
  focus: Box | undefined,
): Transform => {
  if (focus === undefined) {
    const scale = stage.base;
    return {
      scale,
      x: place(stage.width, map.width * scale, 0),
      y: place(stage.height, map.height * scale, 0),
    };
  }
  const fit = Math.min(
    (stage.width - FOCUS_PADDING * 2) / Math.max(1, focus.width),
    (stage.height - FOCUS_PADDING * 2) / Math.max(1, focus.height),
  );
  const scale = Math.max(stage.base, MIN_FOCUS_ZOOM, Math.min(MAX_ZOOM, fit));
  const centreX = (focus.x + focus.width / 2) * scale;
  const centreY = (focus.y + focus.height / 2) * scale;
  return {
    scale,
    x: place(stage.width, map.width * scale, stage.width / 2 - centreX),
    y: place(stage.height, map.height * scale, stage.height / 2 - centreY),
  };
};
