# ADR 0023: Diff viewer: in-house highlighting and virtualisation, a separate diff port

- **Status:** Accepted
- **Date:** 2026-10-27
- **Task:** P6-3

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
   browser's scroll anchoring. Rows wrap (as in the POC), so heights vary, which a fixed-height
   library would not handle; a general library (react-window, TanStack Virtual) would be
   about 6 to 15 KB gz for roughly the same code.
3. **A separate diff port.** `data/diff-data.ts` defines `DiffDataSource.load(ref)`, which
   returns unchecked `{ headSha, diff }`. `parseDiffData` checks the sha, bounds the text
   (20 M characters) and reads it with core's strict `parseUnifiedDiff` (exported as
   `@rocky-reviews/core/diff`, so the browser bundle takes only that module, which has no
   `node:*` imports). Errors name a field or a fixed code, never content. A `DiffProvider` loads the
   diff once, on the first file opened, and holds the reviewer's own comments in memory.
   AI flags and hot lines are shown only when the analysis's head sha equals the diff's; after
   a new push they would point at the wrong lines.
4. **Text safety in code.** Code, hunk headers and flag text render as text. Invisible bidi
   controls (Trojan Source, CVE-2021-42574) render as visible `U+202E`-style markers, and each
   code cell is `direction: ltr; unicode-bidi: isolate`. Paths sit in `<bdi>`.
5. **Keyboard.** The new-side line numbers are buttons with a roving tabindex: one tab stop
   for the diff, arrow keys / Page Up / Page Down / Home / End move between lines (scrolling the
   virtualised list as needed), Enter opens the composer, ⌘/Ctrl+Enter adds, Escape cancels, and
   focus returns to the line.
6. **Evidence.** `e2e/diff.perf.spec.ts` (Playwright project `perf`) runs on the production
   build (`vite build` + `vite preview`), throttles the CPU 4x through CDP, scrolls the
   generated 5,000-line fixture (`?fixture=large-diff`) top to bottom one step per frame while
   recording a Chrome trace, and asserts on the trace (dropped frames from Chrome's
   `PipelineReporter`, no main-thread task over 50 ms) and on rAF intervals. The project depends
   on `visual` and `e2e` so it runs alone.

## Consequences

- Highlighting is coarser than an editor's (no multi-line state, few languages). Adding a
  language means adding a rules entry; a real grammar library can replace the tokenizer later
  behind the same `Token[]` shape.
- Content outside the rendered window is not in the DOM, so in-page find (⌘F) and screen
  readers see only the rows near the viewport, as with other virtualised diff viewers.
- The fixture sources (pr-847 diff from `@rocky-reviews/evals`, the generated large diff) ship
  in the bundle until a server-backed source replaces them.
