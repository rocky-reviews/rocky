# @rocky-reviews/renderer

The change map: the analysis document's graph in, one SVG string out. Adapted from the
[PR Lens](https://github.com/coldteadotai/pr-lens) renderer (MIT, © 2026 Coldtea AI; see
`NOTICE`) at upstream commit `918ffe82cb1dd71d20ce70b27917aeb80a7a4b49`. Decisions: ADR 0021.

```ts
import { renderChangeMap } from "@rocky-reviews/renderer";
import "@rocky-reviews/renderer/change-map.css"; // after tokens.css

const map = renderChangeMap(doc, { idPrefix: "brief" });
// map.status === "rendered": map.svg, map.width, map.height
// map.status === "unavailable": map.svg is the "Change map unavailable" panel, map.reason the
// pipeline's reason (undefined when the document gives none)
```

`map.tree` is the same SVG as a frozen, checked tree (`SafeSvg`) for the web app; see "Safety
seam". `renderChangeMap` takes anything with `graph`, `findings` and `provenance.graphUnavailable`; an
`AnalysisDocument` is one. Pass only the open findings (`{ ...doc, findings: open }`) to leave
dismissed drafts off the badges.

## What it draws

- **Lanes** in `order`, then document order; a lane with no card is not drawn. Fixed width.
- **Cards** stacked in their lane by rank (longest path from a source, cycles broken in document
  order, removed edges ignored), ties by where the card's partners sit, then document order.
  Removed cards sink to the bottom of their lane. Class by delta: `cm-added`, `cm-modified`,
  `cm-unchanged`, `cm-removed` (dashed, struck through).
- **Finding badges** on a card's top-right corner: the number of findings on the files behind the
  card (a file reference with a range only counts findings whose lines overlap it), coloured by
  the worst severity (`cm-critical` … `cm-low`), `9+` above nine. `data-findings` lists the ids,
  worst first. The tooltip has the exact count. The badge is a sibling drawn right after its
  card's group (P5-3).
- **Edges**: a straight drop to the next row of the same lane, the POC's curve to the next lane,
  and routes through the gaps (corridors beside lanes, bands between rows) for anything that
  would otherwise cross a card. Ends sharing a card face are spread along it. Classes: delta,
  `cm-hero` (cyan, dashed: where the change matters), `cm-animated`, `cm-muted`.
- **Edge labels** as opaque pills on their line, placed clear of cards, badges, lane headers and
  each other. A label that needs a corridor widens it, so labels never cover a card (POC defect 3).
- Long text is cut with an ellipsis from a fixed width table; the full text is in `<title>`.

## Determinism

Same input, same bytes, on any machine: no clock, randomness, locale, DOM or I/O; text widths
from a table (`src/text.ts`); every coordinate rounded to two decimals (`src/geometry.ts`); every
sort by number or document order. `render.test.ts` renders each shape 100 times and compares
bytes, and checks the sources for clock, random, locale and DOM use.

## Theming

No colour, style or font attribute is written. `src/change-map.css` maps the `cm-*` classes to the
Slate tokens (`apps/web/src/styles/tokens.css`), so light and dark follow `<html data-mode>`. Font
sizes in the stylesheet must match `src/design.ts`. The raw-colour lint covers this package.

## Safety seam (P5-2)

Labels are model output and treated as hostile (ADR 0022, threat table in `THREATS.md`).
Every element and attribute is built by `src/svg/markup.ts`, which:

- allows only `svg`, `defs`, `marker`, `path`, `g`, `rect`, `text`, `title`, and only the
  attributes the map writes, each with a value shape (numbers, fixed values, `cm-*` class tokens
  from a list, prefixed ids, `url(#id)` markers, schema ids in `data-*`);
- normalises every text: line breaks become spaces; control, bidi, zero-width, tag and other
  invisible characters, lone surrogates and non-characters are dropped (ZWNJ, ZWJ, VS15, VS16 are
  kept only where they join something, at most 32 per string and one joiner per two drawn
  characters); combining-mark runs keep six; `<title>` is capped at 400 code points and `<text>`
  at 200;
- checks the finished document (ids unique and prefixed, every reference resolves) and brands it
  `SafeSvg`.

Refusals throw (the map fails closed) and never echo the refused value.

```tsx
import { SafeSvgView } from "../change-map/SafeSvg.js"; // apps/web
<SafeSvgView svg={renderChangeMap(doc).tree} />;
```

The web app renders `map.tree` as React elements (`apps/web/src/change-map/SafeSvg.ts`); there is
no `innerHTML`. `map.svg` is the same document as a string, for goldens, files and the CLI.

Tests: `inert.test.ts` (157-label hostile corpus incl. the P4-4 injection payloads, parsed with
saxes and walked by `src/inspect.ts`), `fuzz.test.ts` (fast-check), `markup.test.ts` (the seam),
`csp.test.ts`, and in the web app `SafeSvg.test.ts` and `e2e/change-map-csp.e2e.spec.ts`. The
corpus, the inspector and the fixtures are exported for tests as `@rocky-reviews/renderer/testing`.

## Click-through (P5-3)

`renderChangeMap(doc, { interactive: { files } })`, with the PR's changed paths, makes each card
backed by one of them, and each badge whose worst finding is on one, a focusable button
(`tabindex="0"`, `role="button"`, a name that starts with the drawn text); the root becomes a
`group`. Badges are drawn as siblings right after their card, never inside it. The renderer only
marks them: the page reads `data-node` / `data-findings` with `dataset` and resolves them in the
document (`apps/web/src/change-map/targets.ts`). Decisions: ADR 0028.

## Goldens and screenshots

```bash
pnpm vitest run packages/renderer                       # compares against src/__goldens__
UPDATE_GOLDENS=1 pnpm vitest run packages/renderer      # re-records; read the diff before committing
pnpm design:change-map-screenshots                      # docs/design/change-map/, POC side by side
```

## What was taken from PR Lens

| Rocky file         | From PR Lens (`packages/renderer/src/`)       | Changes                                          |
| ------------------ | --------------------------------------------- | ------------------------------------------------ |
| `text.ts`          | `text.ts`                                     | No mono face; tracking folded in; emoji are wide |
| `geometry.ts`      | `geometry.ts`, `bounds.ts`                    | Subset                                           |
| `svg/markup.ts`    | `svg/primitives.ts`                           | Tree; normalisation; name, value, class checks   |
| `layout/rank.ts`   | `layout/rank.ts`                              | No layout hints; iterative (no recursion)        |
| `layout/place.ts`  | `layout/architecture.ts`, `layout/seating.ts` | POC grid; one card per row; no dead band         |
| `layout/routes.ts` | `layout/edges.ts` (approach)                  | POC curve; simple gap routing; rewritten         |
| `layout/labels.ts` | `layout/labels.ts` (approach)                 | Ordered spot search instead of the cost model    |

Not ported: the data-flow and data-model lenses, drill-down views, the walkthrough atlas, icons,
the travelling SMIL pulse and the self-contained literal-colour themes.
