# Threat model: change-map renderer (P5-2)

Companion to [ADR 0022](../../docs/adr/0022-change-map-sanitisation-and-page-sink.md) (sanitisation
and the page sink) and [ADR 0021](../../docs/adr/0021-change-map-renderer.md) (renderer). Each row
names the test that proves the control. Test files are in `src/` unless a path is given.

## Assets

- The reviewer's session in the web app: whatever a script running on the Rocky origin could
  read or do (drafts, posting a review through the API, tokens held by the page).
- The integrity of what the reviewer sees: the map must show what the model said, not something
  hidden, reordered or restyled to mislead (a "safe" lane that is not, a hidden card).
- Logs: refusals must not copy PR content into them.

## Attackers

- Malicious PR content (code, titles, comments, file names) that the model quotes or is steered
  into writing as a label, subtitle, badge or edge label (prompt injection, ADR 0015).
- A model that writes markup, invisible characters or odd ids on its own.
- A caller that hands the renderer a document that never went through the schema parser.
- Another tenant: not a separate path here. The renderer is a pure function over one document;
  tenancy is enforced where the document is loaded (ADR 0003).

## What can go wrong, how it is prevented, how it is tested

| #   | Threat                                                                                                        | Prevention                                                                                                                                                                                                   | Test                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | A label closes `<text>` and opens `<script>`, `<foreignObject>`, `<a>`, `<use>`, `<image>`, `<style>`         | Text is escaped on serialisation and by React; elements outside the allowlist cannot be built                                                                                                                | `inert.test.ts` corpus "markup", "handlers and links", "styles"; `markup.test.ts` "element <…>"; `inspect.ts` walk                                      |
| R2  | A label breaks out of an attribute (`" onload="…`) or adds one                                                | Values double-quoted and escaped (`&quot;` and `&#39;` included); attribute names and value shapes allowlisted                                                                                               | corpus "attribute break-out"; `markup.test.ts` "attribute …", "value …"; fuzz "round-trip through the escaping"                                         |
| R3  | Entities, CDATA, comments, processing instructions or a doctype (XXE, billion laughs) in a label              | `&` is always escaped first, so no entity or markup declaration survives; the parser in tests refuses all of them                                                                                            | corpus "entities", "CDATA, comments and processing instructions"; `inert.test.ts` "the inspector itself"                                                |
| R4  | A `javascript:` / `data:` URL, `xlink:href` or external `url()` that runs or loads something                  | No URL-bearing attribute except `marker-end`, which must be `url(#id)` for an id the same document defines under its prefix                                                                                  | corpus "URLs"; `markup.test.ts` "value marker-end…", "documents and the SafeSvg brand"; `inspect.ts` checks every reference                             |
| R5  | `idPrefix` or an id breaks out of `url(#…)` or collides with another map on the page                          | `idPrefix` must match `^[a-z][a-z0-9-]{0,31}$`; ids are checked unique and under the prefix                                                                                                                  | `inert.test.ts` "refuses an idPrefix…", "namespaces every id…"                                                                                          |
| R6  | CSS injection: a field picks classes (`added cm-hero`, a forged severity) or a data-* value breaks a selector | Class tokens from a fixed list; `delta`, `emphasis`, `severity` must be schema enums; `data-node`/`data-edge` one schema id, `data-findings` schema ids; P5-3 must read values with `dataset`, not selectors | `inert.test.ts` "fails closed on an enum value…", "fails closed on a … id…"; corpus "CSS injection…"                                                    |
| R7  | Inline style or script needed, forcing a weaker CSP (P7-3)                                                    | No `style` attribute, `<style>` or handler is ever written; `change-map.css` loads nothing                                                                                                                   | `csp.test.ts`; `apps/web/e2e/change-map-csp.e2e.spec.ts` (strict CSP, no violation events, control page proves detection)                               |
| R8  | Bidi controls reorder a label (Trojan Source: `txt.exe` shown as `exe.txt`)                                   | Every bidi embedding, override, isolate and mark is dropped (stripping, not isolation; ADR 0022)                                                                                                             | corpus "bidi controls"; `inert.test.ts` "strips every bidi control…"; `markup.test.ts` "bidi controls are dropped"                                      |
| R9  | Zero-width, tag or blank characters hide text, smuggle data or spoof a name (`pay(U+200B)pal`)                | Default-ignorable and format characters dropped, except ZWNJ/ZWJ/VS15/VS16 where they join something; braille blank dropped                                                                                  | corpus "zero-width and invisible"; `inspect.ts` refuses any such character in output; fuzz "normalise exactly as documented"                            |
| R10 | Lone surrogates, non-characters or controls make the SVG ill-formed (the map breaks) or render as garbage     | Dropped before escaping; pairs are matched by code point so astral characters survive                                                                                                                        | corpus "surrogates and non-characters", "controls and line breaks"; fuzz (code-unit strings) parses every output                                        |
| R11 | Very long labels or tooltips bloat the page or overflow the layout                                            | Labels cut by width; `<title>` capped at 400 and `<text>` at 200 code points; combining-mark runs capped at 6                                                                                                | corpus "length", "combining marks"; `inert.test.ts` "caps the output…"; `markup.test.ts` "caps text and titles…"                                        |
| R12 | Upper-casing a lane header lengthens it or adds marks after the checks                                        | Header is upper-cased, then normalised and measured                                                                                                                                                          | corpus "case mapping"; `inert.test.ts` "keeps a lane header's case mapping…"                                                                            |
| R13 | The page re-parses the SVG differently from the tests (mutation XSS) or a forged tree is rendered             | No HTML sink: `SafeSvgView` renders the checked tree as React elements; only trees in the renderer's private `WeakSet` are accepted; trees are frozen                                                        | `apps/web/src/change-map/SafeSvg.test.ts` (React output equals the vetted document for the whole corpus; forged trees throw); `markup.test.ts` "frozen" |
| R14 | A refusal copies PR content into an error that is logged                                                      | Errors name the attribute or field, never the value                                                                                                                                                          | `markup.test.ts` "never echoes a refused value…"                                                                                                        |
| R15 | The pipeline's free-text `graphUnavailable.detail` is drawn                                                   | The unavailable panel draws fixed text only                                                                                                                                                                  | `inert.test.ts` "the unavailable panel"                                                                                                                 |

## Residual risks

- Mixed-direction tooltips (`label · subtitle` with a right-to-left part) can look reordered
  around the separators. No hidden content; accepted (ADR 0022).
- Homoglyphs (Cyrillic `а` for Latin `a`) are drawn as written. The map shows the model's own
  labels, not identifiers a reviewer acts on; file paths are shown and opened from the document.
- The Playwright CSP test runs in `pnpm test:e2e`, which CI does not run yet; the structural CSP
  checks run in `pnpm verify`.
