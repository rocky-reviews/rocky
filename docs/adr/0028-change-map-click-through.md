# ADR 0028: Change-map click-through

- **Status:** Accepted
- **Date:** 2026-10-30
- **Task:** P5-3
- **Builds on:** [ADR 0021](0021-change-map-renderer.md) (renderer), [ADR 0022](0022-change-map-sanitisation-and-page-sink.md) (sanitisation, React sink), [ADR 0023](0023-diff-viewer.md) (diff viewer)

## Context

On the briefing's change map, a card should open its file and a finding badge its finding,
with the mouse and the keyboard. The map is the renderer's SVG put in the page as React
elements (ADR 0022); every id on it comes from the model. The CSP planned for P7-3 allows no
inline script or style, and the web app has no HTML sinks.

Until now the briefing drew an HTML stand-in for the map (P6-2); clicking through needs the real
map, so this task also wires the renderer into `ChangeMapCanvas`, as the P5-2 and P6-2 follow-ups
described.

## Decision

1. **The SVG holds the buttons.** `renderChangeMap(doc, { interactive: { files } })` takes the
   PR's changed files. A card backed by one of them gets `tabindex="0"`, `role="button"` and a
   name: the text drawn on the card (title and subtitle, as cut by the layout, so the name holds
   the visible label, WCAG 2.5.3) then `, opens <path>`. A badge whose worst finding is on a PR
   file gets the same, named `N findings on <label>, worst <severity>: go to <path> line <n>`.
   The root becomes `role="group"` (an `img` would hide its children from assistive technology).
   Without the option the map is the picture it was, byte for byte except for (2).
2. **Badges are siblings of their card,** drawn right after it, so two buttons are never nested
   (axe `nested-interactive`) and Tab goes card, badge, next card. Goldens were regenerated; the
   picture is unchanged.
3. **Fixed values in the allowlists.** `role` may be `img`, `group` or `button`, `tabindex` only
   `0`; `button` only on a `g` and only with `tabindex`, `group`/`img` only on the root. The same
   rules are written again in `src/inspect.ts`, and `tabindex` is in `SafeSvg.ts`'s `PROPS` table.
   `aria-label` is normalised like any text and capped at 400 code points.
4. **The page resolves, never builds.** `ChangeMapCanvas` puts one `onClick` and one `onKeyDown`
   (Enter, Space) on the wrapping `div` (React's delegated listeners, nothing inline). The handler
   takes the nearest `[data-findings], [data-node]` ancestor of the event target inside the
   wrapper and reads `dataset`. `change-map/targets.ts` looks the value up in `Map`s built from
   the document's own nodes and findings: a node opens its first file reference that is a PR
   file; a badge opens its first finding only when every id in the list is a known finding and
   that finding's file is a PR file. Nothing is used as a selector, URL or path, and an unknown
   or partly unknown value does nothing.
5. **A finding opens at its line.** The shell's file selection carries an optional `line`. The
   diff starts with that new-side line (or the nearest one it shows) as its tab stop, scrolls it
   to the middle of the screen and focuses it, after the briefing's focus move to the main column.
   On a diff of another head commit the line is ignored, as AI notes are (ADR 0023).
6. **Fail closed, visibly.** An error boundary around the map shows "Change map unavailable"
   with the fixed code `CM-RENDER` and logs nothing.
7. **Size.** From 760 px of viewport the map shrinks to the column (as the POC's diagram does),
   never below 640 px and never above its drawn size; on phones it keeps its size and scrolls in
   its box.

## Consequences

- A card for a file outside the PR (an existing table, the mailer) stays a picture: no focus,
  no pointer, no action.
- A badge opens the worst finding only. Listing every finding on a card is the right panel's job
  (P6-4).
- Shrinking pr-847's map (915 px) to a 700 px column draws card text at about 9 px. The map is
  wider than the POC's because a label in any inner corridor widens every gap (P5-1 review note).
- `pnpm test:e2e` covers the behaviour (`e2e/change-map.e2e.spec.ts`); it is not part of
  `pnpm verify` yet (P5-2 follow-up).
