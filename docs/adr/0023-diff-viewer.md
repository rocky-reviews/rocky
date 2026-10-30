# ADR 0023: Diff viewer: in-house highlighting and virtualisation, a separate diff port

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P6-3
- **Amended by:** [ADR 0034](0034-pull-request-diff-endpoint.md) (H4-3: the server-backed
  `DiffDataSource`, `truncation`, and a reason per failed load)

## Context

The file view shows one file's diff with syntax highlighting, hunk headers, AI flags, hot-line
markers and the reviewer's own comments, and must scroll a 5,000-line diff at 60 fps on a
mid-range laptop. Diff text, paths and AI flag text are untrusted PR content (ADR 0019 §4). The
shell's data port (ADR 0019 §3) carries the PR summary and the analysis, not the diff.

## Decision

1. **No new dependencies.** Highlighting is a small tokenizer (`apps/web/src/diff/tokenize.ts`)
   for the fixture languages: JS/TS/JSX/JSON, SQL, and `#`-comment languages (YAML, shell,
   Python, TOML); anything else is plain text. It returns `{ kind, text }` tokens that the view
   renders as React text children, never HTML strings. It reads one line in a single linear pass
   (no regular expression over the line), highlights at most 2,000 characters of a line, and
   does not track multi-line strings or comments. Libraries such as Prism or Shiki produce HTML
   strings (which the HTML-sink ban forbids) or add hundreds of KB for grammars the product does
   not need yet.
2. **Windowing in-house too.** `windowing.ts` keeps row heights in a Fenwick tree (O(log n)
   update and lookup); `use-virtual-list.ts` renders the rows near the viewport between two
   spacers, measures rendered rows with a `ResizeObserver` (heights are kept by row key, so
   inserting a comment block keeps the rest), and leaves scroll position steady to the
   browser's scroll anchoring (verified in Chromium; Safari is a follow-up: if WebKit's
   anchoring does not cover it, compensate `scrollTop` by the height change above the window).
   The active line and an open composer are pinned: rendered between their own spacers even
   when outside the window, so focus and a draft never unmount (drafts are also kept by line
   in `DiffBody` state). Rows wrap (as in the POC), so heights vary, which a fixed-height
   library would not handle; a general library (react-window, TanStack Virtual) would be
   about 6 to 15 KB gz for roughly the same code.
3. **A separate diff port.** `data/diff-data.ts` defines `DiffDataSource.load(ref)`, which
   returns unchecked `{ headSha, diff, truncation? }`. `parseDiffData` checks the sha, bounds
   the text (20 M characters), reads `truncation` (H4-3: `null` or `"max_bytes"`, into
   `DiffData.truncated`) and reads the diff with core's strict `parseUnifiedDiff` (exported as
   `@rocky-reviews/core/diff`, so the browser bundle takes only that module, which has no
   `node:*` imports). Errors name a field or a fixed code, never content. A `DiffProvider` loads the
   diff once, on the first file opened, and holds the reviewer's own comments in memory. H4-3:
   `createHttpDiffSource` (`data/diff-http-source.ts`) is the server-backed source for a real PR
   (ADR 0034 §5); a failed load carries a fixed `DiffLoadReason` the file view explains, and a
   truncated diff is said so on every file.
   AI flags and hot lines are shown only when the analysis's head sha equals the diff's; after
   a new push they would point at the wrong lines.
4. **Text safety in code.** Code, hunk headers, notes and flag text render as text, flag text
   and notes inside `<bdi>`. Invisible characters (bidi controls and marks, zero-width and
   invisible operators, U+FEFF, U+00AD, U+180E, U+2028/2029, tag characters U+E0000–E007F;
   Trojan Source, CVE-2021-42574) render as visible `U+XXXX` markers titled "Invisible character
   U+XXXX", and each code cell is `direction: ltr; unicode-bidi: isolate`. Paths sit in `<bdi>`.
5. **Keyboard.** The new-side line numbers are buttons with a roving tabindex: one tab stop
   for the diff, arrow keys / Page Up / Page Down / Home / End move between lines (scrolling the
   virtualised list as needed), Enter opens the composer, ⌘/Ctrl+Enter adds, Escape cancels, and
   focus returns to the line.
6. **Evidence.** `e2e/diff.perf.spec.ts` (Playwright project `perf`) runs on the production
   build (`vite build` + `vite preview`) with no Playwright clock (it would replace
   requestAnimationFrame with a timer; the test asserts rAF is native), throttles the CPU 4x
   through CDP, scrolls the generated 5,000-line fixture (`?fixture=large-diff`) top to bottom
   one step per frame while recording a Chrome trace, and asserts on Chrome's `PipelineReporter`
   (main frames only: FORKED reports skipped, deduplicated by sequence; ≤ 2 % dropped, ≤ 5 %
   partial, presented frames ≥ 95 % of rAF steps), on long tasks (none over 50 ms) and on rAF
   intervals (≥ 58 fps mean, ≤ 5 % over 25 ms). Measured (round 1, four runs): 847–849 of 851
   frames presented, 0–2 dropped, 0 partial, 59.9–60 fps, 0 long tasks. The project depends on
   `visual` and `e2e` so it runs alone.

## Consequences

- Highlighting is coarser than an editor's (no multi-line state, few languages). Adding a
  language means adding a rules entry; a real grammar library can replace the tokenizer later
  behind the same `Token[]` shape.
- Content outside the rendered window is not in the DOM, so in-page find (⌘F) and screen
  readers see only the rows near the viewport, as with other virtualised diff viewers.
- The fixture sources (pr-847 diff from `@rocky-reviews/evals`, the generated large diff) are
  reached only behind H4-2's dev-and-test-only switches; a real PR reads the server (H4-3).
