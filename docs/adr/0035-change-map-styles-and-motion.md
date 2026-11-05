# ADR 0035: Change map styles and motion

- **Status:** Accepted
- **Date:** 2026-11-01
- **Task:** H4-6 (dogfooding follow-up; not a plan row)
- **Amends:** [ADR 0021](0021-change-map-renderer.md) (two renderer options), [ADR 0022](0022-change-map-sanitisation-and-page-sink.md)
  (new class tokens and one fixed attribute), [ADR 0028](0028-change-map-click-through.md)
  (click-through in every style)

## Context

The change map is a still picture. Dogfooding showed that what a reviewer most wants from it is
direction (what calls what, in which order) and a guided path through the change, and the
analysis document already has room for both: edges carry `emphasis: "hero"` and `animated`, and
the graph has `flows` (ordered message sequences) and a `walkthrough` (steps with a heading, a
line and a focus). Three design artboards (Live traffic, Guided walkthrough, Flow playback) set
the look. The pipeline does not generate flows or walkthroughs yet (H4-7, in parallel), so the
page must work with and without them.

Constraints: the map's SVG is built and checked by the renderer (ADR 0022: allowlisted elements,
attributes and classes, no inline style, no element that animates); the CSP is `style-src
'self'` (ADR 0025); click-through must keep working (ADR 0028); colours only through tokens;
`prefers-reduced-motion` must be honoured; the bundle and LCP budgets hold (ADR 0032).

## Decision

### 1. One setting, three styles

`apps/web/src/change-map/map-style.ts`: `live` (Live traffic, the default), `walkthrough`
(Guided walkthrough) and `flows` (Flow playback), stored under `rocky-map-style` in
`localStorage` with the theme's guards (`theme.ts`): every access in `try`, an unknown value
reads as the default, a failed save keeps the choice for the page and says so ("This browser
could not save the choice…", a `role="status"`). The shell owns the state and provides it in a
context; without the shell (tests) the map plays Live traffic.

The control is a `<fieldset>` of three native radio buttons ("Change map style") in the settings
dialog (the shortcuts dialog), beside the light/dark button: arrow keys move between them, each
row is 44 px tall. The top bar has no room for three options; at phone width the light/dark
button is in that dialog too (P6-9), so the two display choices sit together there. The map
section's header has a "Map style: <name>" button that opens the dialog; it is outside the styles,
so it stays the same element when the style changes and the dialog returns focus to it.

### 2. Motion is the stylesheet's, on classes the renderer writes

`renderChangeMap(doc, { motion: true })` adds, without changing the layout or any coordinate:

- `cm-motion` on the root, `cm-wave-<lane index>` (capped at 5) on each card;
- `cm-traffic` on the traffic edges and their labels, `cm-traffic-end` on the cards their dots
  reach;
- a `<g class="cm-pulses">` after the edges with, for each edge that carries dots, a copy of its
  route: `<path class="cm-pulse" d="…" pathLength="100" aria-hidden="true">`.

`change-map.css` turns these into motion: cards rise in lane by lane, then edges and labels fade
in; ordinary edges carry slow dashes; traffic edges are solid AI cyan; a pulse path is a
round-capped zero-length dash every 50 units (two dots per route) whose `stroke-dashoffset` runs
on a loop, so the dots travel the route whatever its length; a ring (`stroke` and width) pings on
the card a dot reaches, in step with the loop; finding badges pulse (a scale on the badge's
circle). Everything that moves is declared inside `@media (prefers-reduced-motion:
no-preference)`; outside it the pulse paths are `display: none`.

Why not the artboards' `offset-path` dots: the path would have to be in a `style` attribute (the
CSP refuses it, ADR 0025) or in a per-edge stylesheet rule built from model output. Why not SMIL
`<animateMotion>`: ADR 0022 allows no element that animates. A dash pattern needs one new
attribute with one fixed value (`pathLength="100"`, allowlisted in `markup.ts`, `inspect.ts`
and `SafeSvg.ts`).

The page adds two switches on its own wrapper: `map-paused` (`animation-play-state: paused` on
everything in the map) and `map-traffic-only` (non-traffic edges fade to 0.14, their label boxes
to 0.3).

### 3. Which edges carry traffic

`trafficEdgeIds` (renderer): the edges the schema marks `emphasis: "hero"` ("the connection the
change is really about"); if the graph marks none, the edges marked `animated`; otherwise none,
and Live traffic shows dashes only and no "Traffic only" button. No schema change: the schema
already says both things.

### 4. Guided walkthrough: focus from the renderer, pan and zoom from the page

`renderChangeMap(doc, { motion: true, focus: { lanes, nodes, edges } })` writes `cm-focus` on the
named lanes, cards (and every card in a named lane) and edges, `cm-dim` on the rest, puts the
dots on the focused edges, and returns `focusBox`, the area they cover. Ids are compared with the
graph's own ids in `Set`s; an id the graph lacks lights nothing, and a focus that names nothing
the graph has is no focus. Dimming fades lines, fills and outlines only: a dimmed card's title
turns `--muted`, label text and badges keep full contrast.

`walkthrough.ts` turns `graph.walkthrough.steps` into stops. Every stop plays over the whole map
(drill-down views and per-flow pictures are not drawn yet): a selection focus is used as is, its
`messages` (when the stage is a flow) light the graph edges joining the same two nodes in either
direction and those nodes; a whole-flow stage lights the flow's participants and those edges; a
view stage with a selection scope lights that selection; anything else is an overview.

The page puts the SVG in a fixed-height stage (`overflow: hidden`) and moves it with a CSS
`transform` (`translate` + `scale`, set through React's `style`, which writes the CSSOM; the CSP
allows that, as the diff viewer already relies on). `fitTransform` fits the overview at a base
scale (never enlarged) and zooms a focus to fill the stage between the base and 1.25×, centred,
without showing space past the map's edges. The transition (0.85 s) is in the no-preference
block. The panel shows "Stop n of N", the heading and line (an `aria-live="polite"` region), a
dot per stop (`aria-current="step"`), Back, Play tour (6 s per stop, stops at the end, absent
with reduced motion) and Next stop. Below a 880 px container the panel sits under the map.

### 5. Flow playback: HTML, not the renderer

A sequence diagram is drawn by the web app as a CSS grid (`FlowPlayback.tsx`): one column per
participant (its `label`, else the node's), a dashed lifeline, one row per message with an arrow
from column centre to column centre (solid for sync, dashed for async and return, a loop for
self). Every label is a React text child inside a `<bdi>`; nothing is measured, so long labels
wrap. Steps run 0…N, where N means fully played: messages before the step are shown, the one at
it is lit (AI background, a token travels along it, its two column heads light up), the rest
have a ghosted line (their text keeps `--muted`, 4.5:1). A flow picker (one `aria-pressed`
button per flow), a numbered timeline, Back, Play (1.6 s per message) and Next; a status line
(`aria-live`) reads the playing message and its note. A column head whose node backs a PR file is
a button that opens it (the same lookup as a card, `targets.ts`).

### 6. Fallback

`mapModeFor(style, graph)`: Guided walkthrough without walkthrough steps, or Flow playback
without flows, plays Live traffic with a notice ("This pull request has no walkthrough, so the
map shows live traffic instead."). The slot is never blank; the document without a graph keeps
the existing "Change map unavailable" state.

### 7. Reduced motion

CSS: no dots, rises, pulses, pings, fades, dash flow, pan easing or token; arrows, the hero
colour, the focus highlight and the lit message stay. JS (`useReducedMotion`, live): no Pause
(nothing moves), no Play in B and C, and C opens fully played. B and C still step by hand.

### 8. Interaction

The pulse group has `pointer-events: none`; cards and badges are the same buttons (P5-3) in A
and B, under the same delegated listeners, so a click or Enter on a moving, dimmed or zoomed
card still opens its file. All controls are buttons with 44 px targets and visible focus rings.

## Consequences

- The default map now moves. The visual baselines that include the map changed (briefing,
  finish, change-map focus pictures); the keyboard dialog pictures show the new setting.
- The renderer allowlist grows by thirteen class tokens and `pathLength="100"` (THREATS.md R17).
- Initial JS stays far under the budget (≈ 166 KB gzipped of 300 KB) and the LCP test passes.
- Tests: `motion.test.ts` and a fuzz property (renderer); `map-style.test.ts`, `map-mode.test.ts`,
  `walkthrough.test.ts`, `flow-playback.test.ts`, `map-styles.test.tsx` (first render per style,
  reduced motion, fallback, and that both stylesheets declare motion only inside the
  no-preference block); `e2e/map-styles.e2e.spec.ts` (setting incl. storage that throws,
  switches, stepping and playing, click-through, fallback, reduced motion, text never faded,
  axe); `e2e/map-styles.visual.spec.ts` (375/1024/1440 × light/dark).

## Residual risks and follow-ups

- A card Tab reaches outside the walkthrough's stage scrolls the stage to show it; the next stop
  resets the scroll. A stop does not yet follow keyboard focus.
- Drill-down views and per-flow pictures are not drawn; a stop on a flow stage is shown on the
  map, not as its sequence.
- The walkthrough and flows only come from fixtures until H4-7 generates them.
