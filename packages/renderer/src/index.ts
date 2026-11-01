/**
 * The change map: a validated analysis document's graph in, one SVG string out.
 *
 * Adapted from the PR Lens renderer (https://github.com/coldteadotai/pr-lens, packages/renderer
 * at 918ffe82cb1dd71d20ce70b27917aeb80a7a4b49), MIT License, Copyright (c) 2026 Coldtea AI.
 * See NOTICE and README.md for what was taken and what changed.
 *
 * Pure and deterministic: no clock, no randomness, no locale, no DOM, no I/O. The same input
 * renders to the same bytes on any machine. Colours are never written into the SVG; every
 * element carries a `cm-*` class that `change-map.css` maps to the Slate tokens, so the page's
 * light/dark mode applies without re-rendering, and no inline style is needed (CSP).
 *
 * Every label is model output: it is normalised before layout (so what is measured is what is
 * drawn) and escaped where it is written (svg/markup.ts). The result carries the SVG twice: as a
 * string for goldens, files and tests, and as `tree`, a frozen, checked `SafeSvg` the web app
 * renders as React elements without any HTML parsing (ADR 0022).
 */
import {
  Delta,
  EdgeEmphasis,
  ID_PATTERN,
  Severity,
  type Finding,
  type Graph,
  type GraphEdge,
  type GraphUnavailable,
  type GraphUnavailableReason,
} from "@rocky-reviews/schema";
import {
  BADGE_HIT_SIZE,
  BADGE_INSET,
  BADGE_MAX_COUNT,
  BADGE_PADDING_X,
  BADGE_ROOM,
  BADGE_SIZE,
  BADGE_TEXT_SIZE,
  CARD_PADDING_X,
  CARD_RADIUS,
  LANE_LABEL_BASELINE,
  LANE_LABEL_SIZE,
  LANE_LABEL_TRACKING,
  LANE_LABEL_X,
  LANE_RADIUS,
  LANE_WIDTH,
  PILL_CLEARANCE,
  PILL_HEIGHT,
  SUBTITLE_BASELINE,
  SUBTITLE_SIZE,
  TITLE_BASELINE,
  TITLE_SIZE,
} from "./design.js";
import { findingsFor, type NodeFindings } from "./findings.js";
import { coord, type Box } from "./geometry.js";
import { pillText, pillWidth, placePills, type Pill } from "./layout/labels.js";
import { placeGrid, seatGraph, type PlacedLane, type PlacedNode } from "./layout/place.js";
import { corridorShortfall, planRoutes, routeEdges, type Route } from "./layout/routes.js";
import {
  cleanText,
  lines,
  serialise,
  svgDocument,
  tag,
  textElement,
  wrap,
  type SafeSvg,
  type SvgElement,
} from "./svg/markup.js";
import { measure, truncate } from "./text.js";

export {
  isSafeSvg,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  type ElementName,
  type SafeSvg,
  type SvgElement,
  type SvgNode,
} from "./svg/markup.js";

/** What the renderer reads from an analysis document; an `AnalysisDocument` is one. */
export type ChangeMapSource = {
  graph?: Graph | undefined;
  /** The findings to badge. Pass the open ones only to leave out dismissed drafts. */
  findings: readonly Finding[];
  provenance: { graphUnavailable?: GraphUnavailable | undefined };
};

export type ChangeMapOptions = {
  /**
   * Prefix for the ids the SVG defines (its arrowheads), so two maps can share a page.
   * Lowercase letters, digits and hyphens, starting with a letter. Default `cm`.
   */
  idPrefix?: string;
  /**
   * Click-through (P5-3, ADR 0028): the paths of the pull request's changed files. A card
   * backed by one of them becomes a button (`tabindex="0"`, `role="button"`, a name saying
   * which file it opens), and so does a finding badge whose worst finding is on one; the
   * root becomes a `group` instead of an `img`, so the buttons are reachable. The page does
   * the opening: it reads `data-node` / `data-findings` and resolves them in the document.
   * Without it the map is a picture, as before.
   */
  interactive?: { files: readonly string[] };
  /**
   * H4-6 (ADR 0035): the animated styles. The root gets `cm-motion`, cards a `cm-wave-<lane>`
   * class (capped) so they rise in lane by lane, and each traffic edge a copy of its route in
   * `cm-pulses` (`cm-pulse`, `pathLength="100"`) the stylesheet turns into travelling dots. The
   * traffic edges are the ones marked `hero`; when none is, the ones marked `animated`
   * (`cm-traffic`). With `focus`, the focused edges carry the dots instead. The cards the dots
   * arrive at are `cm-traffic-end`. Nothing moves without the stylesheet, and nothing here changes the layout.
   */
  motion?: boolean;
  /**
   * H4-6: a walkthrough step. Focused lanes, cards (and the cards in a focused lane) and edges
   * get `cm-focus`, everything else `cm-dim`, and the result's `focusBox` is the area they
   * cover, for the page to pan and zoom to. Ids the graph does not have are ignored; a focus
   * that names nothing the graph has is no focus.
   */
  focus?: MapFocus;
};

export type MapFocus = {
  lanes: readonly string[];
  nodes: readonly string[];
  edges: readonly string[];
};

export type { Box } from "./geometry.js";

export type ChangeMap =
  | {
      status: "rendered";
      svg: string;
      tree: SafeSvg;
      width: number;
      height: number;
      /** With `focus`: the area the focused elements cover (absent when nothing matched). */
      focusBox?: Box;
    }
  | {
      status: "unavailable";
      svg: string;
      tree: SafeSvg;
      width: number;
      height: number;
      /** From `provenance.graphUnavailable`; absent when the document gives none. */
      reason: GraphUnavailableReason | undefined;
    };

/** The heading the briefing shows in place of the map (gate H2 #2). */
export const CHANGE_MAP_UNAVAILABLE = "Change map unavailable";

/**
 * Rocky's own sentence per reason. `graphUnavailable.detail` is never drawn: the map shows
 * fixed text only, whatever the pipeline wrote there.
 */
export const UNAVAILABLE_REASON_TEXT: Readonly<Record<GraphUnavailableReason, string>> = {
  "analysis-failed": "The change map could not be built for this revision.",
  "too-large": "The pull request is too large to map.",
  timeout: "The change map took too long to build.",
  "no-logic": "Nothing to map: Rocky's path rules found only documentation, tooling or CI files.",
};

const ID_PREFIX = /^[a-z][a-z0-9-]{0,31}$/;

const isOneOf = (values: readonly string[], value: unknown): boolean =>
  typeof value === "string" && values.includes(value);

/**
 * The fields that pick classes or end up in data-* hooks. The schema guarantees them; a source
 * that skipped the parser fails closed here, before `added cm-hero` could pick two classes that
 * are each allowed, or an id with a space could split a data-findings list.
 */
const checkSource = (source: ChangeMapSource): void => {
  for (const finding of source.findings) {
    if (!isOneOf(Severity.options, finding.severity))
      throw new Error("renderChangeMap: a finding has an unknown severity (class)");
    if (!ID_PATTERN.test(finding.id))
      throw new Error("renderChangeMap: a finding id is not allowed (data-findings)");
  }
  for (const node of source.graph?.nodes ?? [])
    if (!isOneOf(Delta.options, node.delta))
      throw new Error("renderChangeMap: a node has an unknown delta (class)");
  for (const edge of source.graph?.edges ?? []) {
    if (!isOneOf(Delta.options, edge.delta))
      throw new Error("renderChangeMap: an edge has an unknown delta (class)");
    if (!isOneOf(EdgeEmphasis.options, edge.emphasis))
      throw new Error("renderChangeMap: an edge has an unknown emphasis (class)");
  }
};

/** Every text field the map draws, normalised once, before anything is measured. */
const cleanLabels = (graph: Graph): Graph => ({
  ...graph,
  lanes: graph.lanes.map((lane) => ({
    ...lane,
    label: cleanText(lane.label),
    ...(lane.subtitle === undefined ? {} : { subtitle: cleanText(lane.subtitle) }),
  })),
  nodes: graph.nodes.map((node) => ({
    ...node,
    label: cleanText(node.label),
    ...(node.subtitle === undefined ? {} : { subtitle: cleanText(node.subtitle) }),
    badges: node.badges.map(cleanText),
  })),
  edges: graph.edges.map((edge) => ({
    ...edge,
    ...(edge.label === undefined ? {} : { label: cleanText(edge.label) }),
  })),
});

const ARROWS = ["added", "modified", "removed", "unchanged", "hero"] as const;

const svgRoot = (
  width: number,
  height: number,
  className: string,
  label: string,
  body: readonly (SvgElement | string)[],
  prefix: string,
  role: "img" | "group" = "img",
): { svg: string; tree: SafeSvg } => {
  const tree = svgDocument(
    wrap(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        class: className,
        viewBox: `0 0 ${coord(width)} ${coord(height)}`,
        width: coord(width),
        height: coord(height),
        role,
        "aria-label": label,
      },
      ["\n", ...body, "\n"],
    ),
    prefix,
  );
  return { svg: serialise(tree), tree };
};

const UNAVAILABLE_WIDTH = 400;

const unavailable = (reason: GraphUnavailableReason | undefined, prefix: string): ChangeMap => {
  const height = reason === undefined ? 48 : 68;
  const body = lines([
    tag("rect", {
      class: "cm-unavailable-bg",
      x: 0,
      y: 0,
      width: UNAVAILABLE_WIDTH,
      height,
      rx: LANE_RADIUS,
    }),
    textElement("text", { class: "cm-unavailable-title", x: 16, y: 29 }, CHANGE_MAP_UNAVAILABLE),
    reason === undefined
      ? undefined
      : textElement(
          "text",
          { class: "cm-unavailable-reason", x: 16, y: 50 },
          UNAVAILABLE_REASON_TEXT[reason],
        ),
  ]);
  return {
    status: "unavailable",
    ...svgRoot(
      UNAVAILABLE_WIDTH,
      height,
      "cm cm-unavailable",
      CHANGE_MAP_UNAVAILABLE,
      body,
      prefix,
    ),
    width: UNAVAILABLE_WIDTH,
    height,
    reason,
  };
};

const laneHeader = (placed: PlacedLane): { text: string; full: string; box: Box } => {
  const { lane, box } = placed;
  // Upper-casing can lengthen the text (ß → SS, ﬃ → FFI) or add combining marks (ǰ → J and a
  // combining caron), so it is normalised again afterwards and measured as drawn.
  const full = cleanText(
    (lane.subtitle === undefined ? lane.label : `${lane.label} · ${lane.subtitle}`).toUpperCase(),
  );
  const room = LANE_WIDTH - LANE_LABEL_X * 2;
  const text = truncate(full, "sans-bold", LANE_LABEL_SIZE, room, LANE_LABEL_TRACKING);
  const width = measure(text, "sans-bold", LANE_LABEL_SIZE, LANE_LABEL_TRACKING);
  return {
    text,
    full,
    box: { x: box.x + LANE_LABEL_X, y: LANE_LABEL_BASELINE - 10, width, height: 13 },
  };
};

const badgeLabel = (count: number): string =>
  count > BADGE_MAX_COUNT ? `${BADGE_MAX_COUNT}+` : String(count);

const badgeBox = (card: Box, count: number): Box => {
  const width = Math.max(
    BADGE_SIZE,
    measure(badgeLabel(count), "sans-bold", BADGE_TEXT_SIZE) + BADGE_PADDING_X * 2,
  );
  const centreX = card.x + card.width - BADGE_INSET;
  const centreY = card.y + BADGE_INSET;
  return { x: centreX - width / 2, y: centreY - BADGE_SIZE / 2, width, height: BADGE_SIZE };
};

const nodeTooltip = (placed: PlacedNode, badge: NodeFindings | undefined): string => {
  const { node } = placed;
  const parts = [node.label];
  if (node.subtitle !== undefined) parts.push(node.subtitle);
  if (node.badges.length > 0) parts.push(node.badges.join(", "));
  if (badge !== undefined) {
    const count = badge.findings.length;
    parts.push(`${count} finding${count === 1 ? "" : "s"}, worst ${badge.worst}`);
  }
  return parts.join(" · ");
};

/** What a card and its badge open, when the map is interactive and they back a PR file. */
type Targets = { file: string | undefined; finding: Finding | undefined };

const NO_TARGETS: Targets = { file: undefined, finding: undefined };

const targetsOf = (
  placed: PlacedNode,
  badge: NodeFindings | undefined,
  files: ReadonlySet<string> | undefined,
): Targets => {
  if (files === undefined) return NO_TARGETS;
  const worst = badge?.findings[0];
  return {
    file: placed.node.files.find((ref) => files.has(ref.path))?.path,
    finding: worst !== undefined && files.has(worst.path) ? worst : undefined,
  };
};

/** A focusable SVG button: fixed values, plus a name (normalised like any text). */
const button = (name: string) => ({ tabindex: "0", role: "button", "aria-label": name });

const paintBadge = (
  placed: PlacedNode,
  badge: NodeFindings,
  finding: Finding | undefined,
  dim: boolean,
): SvgElement => {
  const b = badgeBox(placed.box, badge.findings.length);
  const count = badge.findings.length;
  return wrap(
    "g",
    {
      class: `cm-badge cm-${badge.worst}${dim ? " cm-dim" : ""}`,
      "data-findings": badge.findings.map((item) => item.id).join(" "),
      ...(finding === undefined
        ? {}
        : button(
            `${count} finding${count === 1 ? "" : "s"} on ${placed.node.label}, worst ${badge.worst}: ` +
              `go to ${finding.path} line ${finding.range.start}`,
          )),
    },
    [
      // Only a badge that opens something needs the larger target (P6-8).
      ...(finding === undefined
        ? []
        : [
            tag("rect", {
              class: "cm-badge-hit",
              x: coord(b.x + b.width / 2 - BADGE_HIT_SIZE / 2),
              y: coord(b.y + BADGE_SIZE / 2 - BADGE_HIT_SIZE / 2),
              width: BADGE_HIT_SIZE,
              height: BADGE_HIT_SIZE,
            }),
          ]),
      tag("rect", {
        class: "cm-badge-bg",
        x: coord(b.x),
        y: coord(b.y),
        width: coord(b.width),
        height: coord(b.height),
        rx: BADGE_SIZE / 2,
      }),
      textElement(
        "text",
        {
          class: "cm-badge-count",
          x: coord(b.x + b.width / 2),
          y: coord(b.y + BADGE_SIZE / 2 + 3.5),
          "text-anchor": "middle",
        },
        badgeLabel(count),
      ),
    ],
  );
};

/**
 * A card, then its badge as a sibling drawn on top of it (P5-3): two buttons side by side, so
 * neither is nested in the other, and Tab reaches the card and then its badge.
 */
const paintNode = (
  placed: PlacedNode,
  badge: NodeFindings | undefined,
  targets: Targets,
  look: Look,
): SvgElement[] => {
  const { node, box } = placed;
  const textX = box.x + CARD_PADDING_X;
  const room = box.width - CARD_PADDING_X * 2 - (badge === undefined ? 0 : BADGE_ROOM);
  const title = truncate(node.label, "sans-bold", TITLE_SIZE, room);
  const subtitle =
    node.subtitle === undefined
      ? undefined
      : truncate(node.subtitle, "sans", SUBTITLE_SIZE, box.width - CARD_PADDING_X * 2);
  // The name starts with the text drawn on the card, as drawn (WCAG 2.5.3, label in name), so
  // a voice user can say what they see; the full label stays in the tooltip.
  const drawn = subtitle === undefined ? title : `${title} ${subtitle}`;
  const card = wrap(
    "g",
    {
      class: [`cm-node cm-${node.delta}`, ...look.node(placed)].join(" "),
      "data-node": node.id,
      ...(targets.file === undefined ? {} : button(`${drawn}, opens ${targets.file}`)),
    },
    lines([
      textElement("title", {}, nodeTooltip(placed, badge)),
      tag("rect", {
        class: "cm-card",
        x: coord(box.x),
        y: coord(box.y),
        width: coord(box.width),
        height: coord(box.height),
        rx: CARD_RADIUS,
      }),
      textElement(
        "text",
        { class: "cm-node-title", x: coord(textX), y: coord(box.y + TITLE_BASELINE) },
        title,
      ),
      subtitle === undefined
        ? undefined
        : textElement(
            "text",
            { class: "cm-node-sub", x: coord(textX), y: coord(box.y + SUBTITLE_BASELINE) },
            subtitle,
          ),
    ]),
  );
  return badge === undefined
    ? [card]
    : [card, paintBadge(placed, badge, targets.finding, look.dims(node.id))];
};

const edgeClass = (route: Route, look: Look): string => {
  const { edge } = route.plan;
  const classes = ["cm-edge", `cm-${edge.delta}`];
  if (edge.emphasis === "hero") classes.push("cm-hero");
  if (edge.emphasis === "muted") classes.push("cm-muted");
  if (edge.animated) classes.push("cm-animated");
  classes.push(...look.edge(edge.id));
  return classes.join(" ");
};

const paintEdge = (route: Route, prefix: string, look: Look): SvgElement => {
  const { edge, from, to } = route.plan;
  const arrow = edge.emphasis === "hero" ? "hero" : edge.delta;
  const tooltip = [`${from.node.label} → ${to.node.label}`, edge.label]
    .filter((part) => part !== undefined)
    .join(" · ");
  return wrap(
    "path",
    {
      class: edgeClass(route, look),
      "data-edge": edge.id,
      d: route.d,
      "marker-end": `url(#${prefix}-arrow-${arrow})`,
    },
    [textElement("title", {}, tooltip)],
  );
};

const paintPill = (id: string, pill: Pill, look: Look): SvgElement =>
  wrap(
    "g",
    { class: ["cm-label", ...look.edge(id)].join(" "), "data-edge": id, "aria-hidden": "true" },
    [
      tag("rect", {
        class: "cm-pill",
        x: coord(pill.box.x),
        y: coord(pill.box.y),
        width: coord(pill.box.width),
        height: coord(pill.box.height),
        rx: PILL_HEIGHT / 2,
      }),
      textElement(
        "text",
        {
          class: "cm-pill-text",
          x: coord(pill.box.x + pill.box.width / 2),
          y: coord(pill.box.y + PILL_HEIGHT / 2 + 3.3),
          "text-anchor": "middle",
        },
        pill.text,
      ),
    ],
  );

/** The class a focused or dimmed element adds; nothing without a focus. */
const focusClass = (focused: boolean | undefined): string[] =>
  focused === undefined ? [] : [focused ? "cm-focus" : "cm-dim"];

/** Lanes past this one rise with it: the stagger stays short on a wide map. */
const MAX_WAVE = 5;

/**
 * H4-6: the extra classes motion and focus add to each element, decided once per render. Every
 * id is compared against the graph's own ids in Sets; none is ever written into a class.
 */
type Look = {
  lane: (index: number) => string[];
  node: (placed: PlacedNode) => string[];
  /** Whether a card's badge dims with it. */
  dims: (id: string) => boolean;
  edge: (id: string) => string[];
  /** The edges that carry travelling dots. */
  pulsed: (id: string) => boolean;
};

type ResolvedFocus = { lanes: Set<number>; nodes: Set<string>; edges: Set<string> };

const resolveFocus = (
  focus: MapFocus | undefined,
  placement: { lanes: readonly PlacedLane[]; nodes: readonly PlacedNode[] },
  routes: readonly Route[],
): ResolvedFocus | undefined => {
  if (focus === undefined) return undefined;
  const laneIds = new Set(focus.lanes);
  const lanes = new Set(
    placement.lanes.filter(({ lane }) => laneIds.has(lane.id)).map(({ index }) => index),
  );
  const nodeIds = new Set(focus.nodes);
  const nodes = new Set(
    placement.nodes
      .filter(({ node, lane }) => nodeIds.has(node.id) || lanes.has(lane))
      .map(({ node }) => node.id),
  );
  const edgeIds = new Set(focus.edges);
  const edges = new Set(
    routes.filter(({ plan }) => edgeIds.has(plan.edge.id)).map(({ plan }) => plan.edge.id),
  );
  return lanes.size + nodes.size + edges.size === 0 ? undefined : { lanes, nodes, edges };
};

/**
 * H4-6 (ADR 0035): the edges the Live traffic style moves dots along. The schema's `hero`
 * emphasis is "the connection the change is really about"; when the graph marks none, the
 * edges it marks `animated` stand in. Exported so the page can tell whether there is traffic.
 */
export const trafficEdgeIds = (edges: readonly GraphEdge[]): ReadonlySet<string> => {
  const hero = edges.filter((edge) => edge.emphasis === "hero");
  return new Set((hero.length > 0 ? hero : edges.filter((edge) => edge.animated)).map((e) => e.id));
};

const lookOf = (
  motion: boolean,
  focus: ResolvedFocus | undefined,
  routes: readonly Route[],
): Look => {
  const traffic = motion ? trafficEdgeIds(routes.map(({ plan }) => plan.edge)) : new Set<string>();
  const pulsed = (id: string): boolean =>
    motion && (focus === undefined ? traffic.has(id) : focus.edges.has(id));
  // The cards the dots arrive at: the walkthrough's own edges when it has a focus.
  const ends = new Set(
    routes.filter(({ plan }) => pulsed(plan.edge.id)).map(({ plan }) => plan.to.node.id),
  );
  return {
    lane: (index) => focusClass(focus?.lanes.has(index)),
    node: ({ node, lane }) => [
      ...(motion ? [`cm-wave-${Math.min(lane, MAX_WAVE)}`] : []),
      ...(ends.has(node.id) ? ["cm-traffic-end"] : []),
      ...focusClass(focus?.nodes.has(node.id)),
    ],
    dims: (id) => focus !== undefined && !focus.nodes.has(id),
    edge: (id) => [...(traffic.has(id) ? ["cm-traffic"] : []), ...focusClass(focus?.edges.has(id))],
    pulsed,
  };
};

/** The area a focus covers: its lanes, its cards, and both ends of its edges. */
const focusArea = (
  focus: ResolvedFocus,
  placement: { lanes: readonly PlacedLane[]; byId: ReadonlyMap<string, PlacedNode> },
  routes: readonly Route[],
): Box => {
  const cards = [
    ...focus.nodes,
    ...routes
      .filter(({ plan }) => focus.edges.has(plan.edge.id))
      .flatMap(({ plan }) => [plan.from.node.id, plan.to.node.id]),
  ];
  const boxes: Box[] = [
    ...placement.lanes.filter(({ index }) => focus.lanes.has(index)).map(({ box }) => box),
    ...cards.flatMap((id) => {
      const placed = placement.byId.get(id);
      return placed === undefined ? [] : [placed.box];
    }),
  ];
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/** A copy of an edge's route for the travelling dots: decorative, never a target. */
const paintPulse = (route: Route): SvgElement =>
  tag("path", { class: "cm-pulse", d: route.d, pathLength: 100, "aria-hidden": "true" });

const markers = (prefix: string): SvgElement =>
  wrap(
    "defs",
    {},
    ARROWS.map((tone) =>
      wrap(
        "marker",
        {
          id: `${prefix}-arrow-${tone}`,
          viewBox: "0 0 10 10",
          refX: 9,
          refY: 5,
          // Markers scale with the stroke: the hero line is 2.4 wide, the others 1.4, so the hero
          // head is drawn smaller to land at the same size.
          markerWidth: tone === "hero" ? 4.5 : 7,
          markerHeight: tone === "hero" ? 4.5 : 7,
          orient: "auto-start-reverse",
        },
        [tag("path", { class: `cm-arrow cm-arrow-${tone}`, d: "M0,0 L10,5 L0,10 z" })],
      ),
    ),
  );

/**
 * Renders the change map, or the "Change map unavailable" panel when the document has no
 * graph (the pipeline's reason, if any, is in `reason`) or a graph with nothing to draw.
 */
export const renderChangeMap = (
  source: ChangeMapSource,
  options: ChangeMapOptions = {},
): ChangeMap => {
  const prefix = options.idPrefix ?? "cm";
  if (!ID_PREFIX.test(prefix))
    throw new Error("renderChangeMap: idPrefix must be lowercase letters, digits and hyphens");

  checkSource(source);
  const files = options.interactive === undefined ? undefined : new Set(options.interactive.files);

  if (source.graph === undefined)
    return unavailable(source.provenance.graphUnavailable?.reason, prefix);
  const graph = cleanLabels(source.graph);

  const grid = seatGraph(graph);
  if (grid.seats.length === 0) return unavailable(undefined, prefix);

  const plans = planRoutes(grid, graph.edges);
  const widen = new Map<number, number>();
  for (const plan of plans) {
    const { label } = plan.edge;
    if (label === undefined || plan.labelCorridor === undefined) continue;
    const need = corridorShortfall(
      plan.labelCorridor,
      grid.lanes.length,
      pillWidth(pillText(label)),
      plan.kind,
    );
    // Gaps between lanes widen together, so the lanes stay evenly spaced (as in the POC); the
    // outer margins widen on their own.
    const inner = plan.labelCorridor > 0 && plan.labelCorridor < grid.lanes.length;
    for (const corridor of inner
      ? Array.from({ length: grid.lanes.length - 1 }, (_, index) => index + 1)
      : [plan.labelCorridor])
      widen.set(corridor, Math.max(widen.get(corridor) ?? 0, need));
  }
  const placement = placeGrid(grid, widen);

  const badges = new Map(
    placement.nodes.map((placed) => [placed.node.id, findingsFor(placed.node, source.findings)]),
  );
  const badged = new Set(
    placement.nodes.flatMap(({ node }) => (badges.get(node.id) === undefined ? [] : [node.id])),
  );
  const routes = routeEdges(plans, placement, badged);
  const headers = placement.lanes.map(laneHeader);
  const obstacles: Box[] = [
    ...placement.nodes.map(({ box }) => box),
    ...placement.nodes.flatMap(({ node, box }) => {
      const badge = badges.get(node.id);
      return badge === undefined ? [] : [badgeBox(box, badge.findings.length)];
    }),
    ...headers.map(({ box }) => box),
  ];
  const focus = resolveFocus(options.focus, placement, routes);
  const look = lookOf(options.motion === true, focus, routes);
  const pills = placePills(routes, obstacles, {
    x: 0,
    y: 0,
    width: placement.width,
    height: placement.height,
  });

  // A pill pushed past the lanes (a loop's label on the last lane) grows the canvas.
  const drawn = [...pills.values()].map(({ box }) => box);
  const width = Math.ceil(
    Math.max(placement.width, ...drawn.map((box) => box.x + box.width + PILL_CLEARANCE)),
  );
  const height = Math.ceil(
    Math.max(placement.height, ...drawn.map((box) => box.y + box.height + PILL_CLEARANCE)),
  );

  const body = lines([
    markers(prefix),
    wrap(
      "g",
      { class: "cm-lanes" },
      lines(
        placement.lanes.map((placed, index) => {
          const header = headers[index] ?? laneHeader(placed);
          return wrap(
            "g",
            { class: ["cm-lane", ...look.lane(placed.index)].join(" ") },
            lines([
              header.text === header.full ? undefined : textElement("title", {}, header.full),
              tag("rect", {
                class: "cm-lane-bg",
                x: coord(placed.box.x),
                y: coord(placed.box.y),
                width: coord(placed.box.width),
                height: coord(placed.box.height),
                rx: LANE_RADIUS,
              }),
              textElement(
                "text",
                {
                  class: "cm-lane-label",
                  x: coord(placed.box.x + LANE_LABEL_X),
                  y: LANE_LABEL_BASELINE,
                },
                header.text,
              ),
            ]),
          );
        }),
      ),
    ),
    wrap("g", { class: "cm-edges" }, lines(routes.map((route) => paintEdge(route, prefix, look)))),
    options.motion === true
      ? wrap(
          "g",
          { class: "cm-pulses" },
          lines(routes.filter(({ plan }) => look.pulsed(plan.edge.id)).map(paintPulse)),
        )
      : undefined,
    wrap(
      "g",
      { class: "cm-nodes" },
      lines(
        placement.nodes.flatMap((placed) => {
          const badge = badges.get(placed.node.id);
          return paintNode(placed, badge, targetsOf(placed, badge, files), look);
        }),
      ),
    ),
    wrap(
      "g",
      { class: "cm-labels" },
      lines(
        routes.flatMap(({ plan }, index) => {
          const pill = pills.get(index);
          return pill === undefined ? [] : [paintPill(plan.edge.id, pill, look)];
        }),
      ),
    ),
  ]);

  return {
    status: "rendered",
    ...svgRoot(
      width,
      height,
      options.motion === true ? "cm cm-motion" : "cm",
      "Change map",
      body,
      prefix,
      files === undefined ? "img" : "group",
    ),
    width,
    height,
    ...(focus === undefined ? {} : { focusBox: focusArea(focus, placement, routes) }),
  };
};
