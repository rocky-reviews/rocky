# ADR 0019: Change-map renderer

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P5-1

## Context

The briefing (P6-2) shows the analysis document's graph as a diagram in the POC's style:
lanes, cards coloured by delta, hero edges, edge labels and finding badges, in light and dark.
PR Lens (MIT) has a deterministic renderer for the same graph shape. Its SVGs are written for
GitHub comments: self-contained, literal colours, one file per theme. Rocky draws the map inside
its own page, where the theme can change without a re-render, and where the CSP should not have
to allow inline styles. Labels come from a model, so the output also has to be inert.

## Decision

1. **Adapt, don't vendor.** `packages/renderer` ports the parts of the PR Lens renderer that fit
   (text measurement from a table, coordinate rounding, ranking with cycle breaking, lane
   ordering, the partner tie-break, gap routing, label pills, XML escaping), from upstream commit
   `918ffe82cb1dd71d20ce70b27917aeb80a7a4b49`, with the MIT notice in each adapted file and in
   `NOTICE`. The layout is the POC's compact grid (fixed-width lanes, one card per row, rows
   counted per lane), not PR Lens's shared row grid. Only the architecture view is ported; flows,
   payloads and drill-down views stay in the document for later tasks.
2. **Classes, not colours.** The SVG carries `cm-*` classes and no fill, stroke, style or font
   attribute. `packages/renderer/src/change-map.css` maps the classes to the Slate tokens, so the
   page's `data-mode` switches the map with everything else and no inline `<style>` or `style=`
   is needed. The raw-colour lint covers the package.
3. **Pure function, fixed bytes.** `renderChangeMap(source, options)` returns an SVG string. No
   clock, randomness, locale, DOM or I/O; text widths from a table; coordinates rounded to two
   decimals; sorts by number and document order. Tests render every shape 100 times and compare
   bytes, and golden SVGs pin the output.
4. **Unavailable is a result, not an error.** A document without a graph, or a graph with
   nothing to draw, gives `status: "unavailable"` with the pipeline's reason and a small panel
   that says "Change map unavailable" plus Rocky's own sentence for the reason. The pipeline's
   `detail` is never drawn.
5. **One markup seam.** Every element and attribute goes through `src/svg/markup.ts`, which
   escapes every value and refuses any element or attribute outside an allowlist (no script,
   foreignObject, `on*`, `href`, `style`). P5-2 hardens and tests this seam.
6. **Ids are namespaced.** Marker ids take a caller-chosen prefix so two maps can share a page.

## Consequences

- The web app must load `change-map.css` (export `@rocky-reviews/renderer/change-map.css`) after
  `tokens.css`. Font sizes in the stylesheet and in `src/design.ts` must change together.
- A label that needs room widens the gap it sits in, which moves the lanes after it. A rename can
  therefore move later lanes sideways (PR Lens avoids that by never widening); accepted so
  labels never cover a card (POC defect 3).
- The SVG is not a standalone image: opened without the stylesheet it is unstyled. A comment or
  export surface that needs a self-contained file needs a separate theme pass.
