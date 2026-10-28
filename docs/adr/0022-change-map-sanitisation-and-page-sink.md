# ADR 0022: Change-map sanitisation and how the SVG reaches the page

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P5-2 (🔴)
- **Builds on:** [ADR 0021](0021-change-map-renderer.md) (renderer), [ADR 0015](0015-prompt-injection-defence.md) (PR content is untrusted), [ADR 0019](0019-web-app-shell.md) (no HTML sinks)

## Context

Every label on the change map is model output, and the model reads PR content an attacker
controls. The schema bounds lengths and refuses control and invisible characters, but it does not
refuse markup, and the renderer is also called on documents that never went through the parser
(tests, the CLI, later callers). P5-1 left one seam for this: `packages/renderer/src/svg/markup.ts`
escapes every value and allowlists element and attribute names.

Two questions were open:

1. What exactly does the renderer guarantee about its output, and how is that proved?
2. How does the SVG get into the page? The web app bans `innerHTML`, `dangerouslySetInnerHTML`
   and the other HTML sinks by lint (P6-1). P5-3 needs clicks on cards and badges. P7-3 will set
   a CSP with no inline scripts and `style-src 'self'`.

## Decision

### 1. The renderer's guarantee

`markup.ts` builds a frozen tree instead of strings, and checks everything it is given:

- **Elements:** `svg`, `defs`, `marker`, `path`, `g`, `rect`, `text`, `title`. Nothing that runs,
  embeds, links, animates or styles (no `script`, `foreignObject`, `a`, `use`, `image`, `style`,
  `animate`, `set`).
- **Attributes, by name and by value shape:** geometry must be a plain decimal; `d` only absolute
  `M L C Q Z` commands and numbers; `class` only tokens from a fixed list of `cm-*` classes;
  `id` lowercase and, for the finished document, under the caller's `idPrefix`; `marker-end`
  only `url(#<id>)`; `role`, `aria-hidden`, `text-anchor`, `orient` and `xmlns` fixed values;
  `data-node`/`data-edge` one schema id, `data-findings` schema ids separated by single spaces;
  `aria-label` free text. No `on*`, `href`, `xlink:href`, `src`, `style` or presentation colour.
  A non-text value with the wrong shape is refused, not repaired, so an id cannot quietly
  become another id.
- **Document:** one `<svg>` root in the SVG namespace, `xmlns` nowhere else, every id unique
  and under the prefix, every `url(#…)` pointing at one of those ids. The only URLs in the output
  are these internal arrowhead references.
- **Source fields that pick classes** (`delta`, `emphasis`, `severity`) must be schema enum
  values, and finding ids schema ids; otherwise `renderChangeMap` throws. Two allowed tokens
  combined (`added cm-hero`) are therefore refused too.
- **Text** is normalised, then escaped on serialisation (React escapes the same tree again):
  1. tab, CR, LF, NEL, U+2028 and U+2029 become a space;
  2. dropped: control characters (C0, DEL, C1), lone surrogates, non-characters, every
     default-ignorable or format character (zero-width space, word joiner, BOM, soft hyphen, the
     TAG block, bidi embeddings, overrides, isolates and marks), and the braille blank, except
     ZWNJ, ZWJ, VS15 and VS16;
  3. ZWNJ/ZWJ are dropped at the start, after another ZWNJ/ZWJ, before a space and at the end;
     VS15/VS16 are dropped at the start and after another VS15/VS16;
  4. runs of combining marks keep their first six;
  5. a `<title>` is cut at 400 code points and a `<text>` at 200, with an ellipsis (the layout
     already cuts drawn text far shorter, by width).
     Labels are normalised before layout, so what is measured is what is drawn. Lane headers are
     upper-cased and then normalised again, because case mapping can lengthen text (ß → SS) or add
     combining marks. No Unicode normalisation form is applied.
- **Fail closed.** Any refusal throws; the briefing shows its error state instead of a map.
  Errors name the attribute, never the value, because values can be PR content and errors can
  be logged.

**Bidi and zero-width characters are stripped, not isolated.** Isolation (`<bdi>`, FSI…PDI,
`unicode-bidi: isolate`) protects the text _around_ a label from the label's direction, but a
right-to-left override _inside_ the label still reverses the rest of that label, which is the
Trojan Source spoof (`txt.exe` shown as `exe.txt`). Zero-width characters cannot be isolated
into visibility at all. Stripping matches what the schema already refuses, so in practice it only
ever removes characters the parser would have rejected. Real right-to-left text needs no
controls: each `<text>` is its own bidi paragraph and the Unicode algorithm orders it from the
characters themselves. The joiners emoji and some scripts need are kept, only where they can join.

**Proof is structural.** Tests parse every output with saxes (a strict XML 1.0 parser with
namespace checking, the one jsdom uses for XML; exact-pinned dev dependency, one transitive
dependency, no network or entity expansion) and walk the tree with rules written out a second
time in `src/inspect.ts`, so loosening the renderer's allowlist cannot loosen the test. The
corpus (`src/hostile-corpus.ts`) has 157 labels across 16 techniques, including all 37 P4-4
injection payloads, plus hostile ids and prefixes; a fast-check property test adds random
strings built from code units, code points and markup fragments. Text content is compared with
an independent step-by-step implementation of the normalisation above (`src/reference-normalise.ts`).

### 2. The page sink: React elements from the checked tree

`renderChangeMap` returns `tree`, a frozen `SafeSvg`, alongside the `svg` string. The web app
renders the tree with `SafeSvgView` (`apps/web/src/change-map/SafeSvg.ts`): one
`createElement` per node, attribute names mapped from a fixed table. `SafeSvgView` accepts only a
tree that `svgDocument` checked (a module-private `WeakSet`, not a property), so a copy, a
fragment or an object literal throws.

| Option                                                    | Scripts                         | Clicks (P5-3)            | Theming via page CSS                       | CSP (P7-3)                                  | Parser in the browser                                                 |
| --------------------------------------------------------- | ------------------------------- | ------------------------ | ------------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------- |
| **React elements from the tree (chosen)**                 | none: no markup is parsed       | yes, normal React events | yes                                        | nothing inline                              | none                                                                  |
| `<img src="data:image/svg+xml…">` or blob URL             | never run                       | no (an image is opaque)  | no: page styles do not reach into an image | needs `img-src data:` or `blob:`            | the SVG image parser                                                  |
| One lint-allowed `innerHTML` sink taking a branded string | inert only if escaping is right | yes, by delegation       | yes                                        | nothing inline; Trusted Types policy needed | the HTML parser in foreign-content mode, a known mutation-XSS surface |

The image option was rejected because the map is coloured by `change-map.css` from the page's
tokens (ADR 0021 §2): an SVG loaded as an image cannot see page styles, so it would need inline
`<style>` and a re-render per theme, and P5-3 could not click a card. The `innerHTML` option keeps
the lint ban's one exception alive forever and relies on the HTML parser reading the XML the same
way the tests did; serialisation and re-parsing differences between the two are where mutation
XSS lives. The tree costs nothing extra (the renderer already built it to write the string) and
the string stays for goldens, screenshots, files and the CLI.

**CSP.** The output has no `style` attribute, no `<style>`, no script and no handler, and
`change-map.css` loads nothing (no `url()` or `@import`). `apps/web/e2e/change-map-csp.e2e.spec.ts`
serves the map, as string and as React output, with
`default-src 'self'; style-src 'self'; script-src 'self'` and expects no
`securitypolicyviolation` (a control page with one inline style must raise one), and the external
stylesheet to have coloured the cards.

## Consequences

- P6-2 wires the map in one change inside `ChangeMapCanvas`:
  `<SafeSvgView svg={renderChangeMap({ ...doc, findings: open }).tree} />` in a scrolling box,
  plus `@rocky-reviews/renderer/change-map.css` after `tokens.css`. Recorded as a follow-up.
- P5-3 adds one click handler on the wrapper and reads `data-node` / `data-findings` through
  `closest()` and `dataset`; the values must never be used to build a selector or URL without
  `CSS.escape` or a lookup in the document's own ids. Focusable cards will need `tabindex` (and
  maybe `role="button"`): each is a fixed value to add to both allowlists (`svg/markup.ts`,
  `src/inspect.ts`) and to the `PROPS` table in `SafeSvg.ts`, with a test.
- Adding an element, attribute or class is a deliberate three-file change, by design.
- A document that skipped the parser and carries a bad enum or id fails the whole map rather
  than a single card. Production documents are always parsed, so this only bites tests and new
  callers, loudly.
- Mixed-direction text joined into one tooltip (`label · subtitle`) can still look reordered
  around the `·` separators when parts are right-to-left; no hidden content is involved.
- The Playwright CSP test runs with `pnpm test:e2e`, not in `pnpm verify`; the structural CSP
  checks (`packages/renderer/src/csp.test.ts`) do run in `pnpm verify`.
