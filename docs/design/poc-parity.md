# POC parity checklist

Every feature, state, interaction and shortcut in `design-poc/index.html`, mapped to the task
that builds it in the real app (task P0-9). Screenshots of each state: [`poc/README.md`](poc/README.md).

Phase 6 PRs tick items here (`[x]` + link to the screenshot that proves it). Phase 6 is done
when every item is `[x]` or has a written reason in **Intentional differences**. The P6-9 audit
compared every state side by side and checked these ticks: [`parity-audit.md`](parity-audit.md).

## Top bar

- [x] P6-1 · Brand mark + "Rocky Reviews" — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png); the Rocky mountain since H4-18 (see Intentional differences)
- [x] P6-1 · PR title + `#number` — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png)
- [x] P6-1 · Status pill: Open / Approved / Changes requested / Commented (changes after submit) — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png); the submitted states render from `myReview` (`Shell.test.tsx`), set by Finish review in P6-6
- [x] P6-1 · Repo name, "@author wants to merge `head` → `base`" — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png)
- [x] P6-1 · +additions / −deletions · file count · "updated N ago" — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png)
- [x] P6-1 · Existing approvals count with approvers on hover (from GitHub) — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png); tooltip also on keyboard focus, Escape closes it (`shell.e2e.spec.ts`)
- [x] P6-1 · Existing comments count (from GitHub) — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png)
- [x] P6-1 · "View on GitHub ↗" link (opens the PR) — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png); built from validated owner/repo/number only
- [x] P6-1 · Light/dark toggle (☾/☀), remembered per browser, defaults to system — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png); no flash on load, storage failures tolerated (`shell.e2e.spec.ts` theme tests)
- [x] P6-5 · "? Shortcuts" button — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-375-dark](../../apps/web/e2e/__screenshots__/pr-shell-375-dark.png) (just "?" below 1180 px, kept below 760 px so the dialog, its off switch and, there, the theme toggle are reachable at every width); opens the shortcuts dialog (`keyboard.e2e.spec.ts` "the shortcuts dialog")
- [x] P6-6 · "Finish review" primary button with pending-comment count — [finish-1440-light](../../apps/web/e2e/__screenshots__/finish-1440-light.png), [finish-375-dark](../../apps/web/e2e/__screenshots__/finish-375-dark.png); the count is accepted drafts plus own comments not yet posted (`Shell.test.tsx`, `finish.e2e.spec.ts`); the label is visible at every width since P6-9 (it was hidden below 760 px: [audit D2](parity-audit.md))

## Sidebar (triage)

- [x] P6-1 · Coverage card: "Critical + Important reviewed n/m", progress bar, high-risk files left (H4-9: "N high-risk files left", a count; the minutes are hidden), "all reviewed ✓" state — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png)
- [x] P6-2 · "Briefing & change map" entry — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png); built with the P6-1 sidebar, returns to the briefing (`briefing.e2e.spec.ts` "the Briefing & change map entry returns to the briefing")
- [x] P6-1 · Files grouped by risk level (Critical, Important, Normal, Low) with counts — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png)
- [x] P6-1 · Per file: viewed checkbox, path (truncated from the left), severity dots per finding (faded when decided), risk score badge — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png); faded dots once decided (P6-4): [drafts-dismissed-1024-dark](../../apps/web/e2e/__screenshots__/drafts-dismissed-1024-dark.png)
- [x] P6-1 · Viewed files struck through — `shell.e2e.spec.ts` "viewed checkboxes update coverage and strike the file through"
- [x] P6-1 · Noise group: collapsed summary box with "Trust & mark viewed" and "Show" — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png)
- [x] P6-1 · Noise files listed once shown or trusted — `shell.e2e.spec.ts` "noise: Show lists the files, Trust marks them viewed"
- [x] H4-9 · Normal, Low and noise collapsed by default (headers and counts only) behind one "Show N lower-risk files" / "Hide lower-risk files" toggle, remembered per browser (`rocky-sidebar-lower-risk`); a selected file's group always shows its rows — [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-shell-lower-risk-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-lower-risk-1440-light.png), [pr-shell-lower-risk-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-lower-risk-1440-dark.png); `Sidebar.test.tsx`, `shell.e2e.spec.ts` "lower-risk files: …"
- [x] H4-12 · Change tree (not in the POC; mockup "A · Compact tree"): a "Tree" button with a folder icon and its `t` hint under the coverage card (also in the 375 px Files drawer), "View as tree" after the briefing's risk chips, and `t` open one modal. Only changed folders, single-child chains collapsed (`api/routes/`), root files in "(root config)"; each folder row has a caret, its worst-level dot, the name with "/", "new" when every file was added, "N files · K to read", lines changed and a risk bar; key files named, the rest folded into "+ N more files (M tests)"; biggest folder first, the riskiest open (down to its files to read); "new" only when every changed file under the folder was added, ignored ones included; not analysed files a visible group, ignored files (low + noise) one collapsed line. A file click opens it like the sidebar and closes the modal; the open file is highlighted — [change-tree-1440-light](../../apps/web/e2e/__screenshots__/change-tree-1440-light.png), [change-tree-1440-dark](../../apps/web/e2e/__screenshots__/change-tree-1440-dark.png), [change-tree-1024-light](../../apps/web/e2e/__screenshots__/change-tree-1024-light.png), [change-tree-375-dark](../../apps/web/e2e/__screenshots__/change-tree-375-dark.png), [change-tree-file-1440-light](../../apps/web/e2e/__screenshots__/change-tree-file-1440-light.png), [change-tree-file-375-dark](../../apps/web/e2e/__screenshots__/change-tree-file-375-dark.png), Not analysed group [change-tree-unanalysed-1440-light](../../apps/web/e2e/__screenshots__/change-tree-unanalysed-1440-light.png), [change-tree-unanalysed-375-dark](../../apps/web/e2e/__screenshots__/change-tree-unanalysed-375-dark.png), [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png), [pr-files-drawer-375-light](../../apps/web/e2e/__screenshots__/pr-files-drawer-375-light.png), [brief-375-dark](../../apps/web/e2e/__screenshots__/brief-375-dark.png); `change-tree-model.test.ts`, `ChangeTreeDialog.test.tsx`, `change-tree.e2e.spec.ts` (each entry point, Escape returns focus, Tab trap, file click, 375 px drawer, axe 0 serious at every width and mode)

## Briefing (P6-2)

- [x] "✦ AI briefing" header (H4-9: the POC's "· est. ~N min review" is hidden until the estimate is deterministic) — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png), [brief-1440-dark](../../apps/web/e2e/__screenshots__/brief-1440-dark.png); "Briefing by Rocky" when the pipeline wrote it ([brief-by-rocky-1440-light](../../apps/web/e2e/__screenshots__/brief-by-rocky-1440-light.png))
- [x] Summary paragraph (intent of the PR) — H4-8: a schema 1.4 document opens with the verdict and a "TL;DR" list of 2–4 one-line bullets ([brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png), [brief-375-dark](../../apps/web/e2e/__screenshots__/brief-375-dark.png)); an older document keeps the paragraph above the verdict ([brief-summary-only-1440-light](../../apps/web/e2e/__screenshots__/brief-summary-only-1440-light.png), [brief-by-rocky-1440-light](../../apps/web/e2e/__screenshots__/brief-by-rocky-1440-light.png)); `**bold**` and `` `code` `` render as elements, the rest as text (`inline-text.test.tsx`)
- [x] Risk verdict box (level + why) — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png), [brief-375-dark](../../apps/web/e2e/__screenshots__/brief-375-dark.png)
- [x] Risk table (H4-10: replaced by count chips, see the next item and Intentional differences): Critical "need your attention", Important "worth a careful look", Normal "to skim", Ignore "don't matter" (low + noise), with clickable file names — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png), stacked at phone width [brief-375-light](../../apps/web/e2e/__screenshots__/brief-375-light.png); a click selects the file in the sidebar and main column (`briefing.e2e.spec.ts` "clickable files"); a "Not analysed" row when `provenance.unanalysed` is not empty ([brief-map-unavailable-1024-light](../../apps/web/e2e/__screenshots__/brief-map-unavailable-1024-light.png))
- [x] H4-10 · Files by risk as count chips: under a "Files by risk" heading, one chip per level with files (dot, label, count: "Critical 3", "Normal 2", "Not analysed 1"), ordered Critical, Important, Normal, Not analysed, Ignore (as the sidebar), the first selected; the selected level's files are listed below and open on click; a click on a chip swaps the list. WAI-ARIA tabs: one tab stop, Left/Right/Home/End, one panel named by its tab. The chips wrap at phone width — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png), [brief-375-dark](../../apps/web/e2e/__screenshots__/brief-375-dark.png), with Not analysed [brief-map-unavailable-1024-light](../../apps/web/e2e/__screenshots__/brief-map-unavailable-1024-light.png), [brief-map-unavailable-375-light](../../apps/web/e2e/__screenshots__/brief-map-unavailable-375-light.png), Normal selected [brief-risk-chip-1440-light](../../apps/web/e2e/__screenshots__/brief-risk-chip-1440-light.png), [brief-risk-chip-375-dark](../../apps/web/e2e/__screenshots__/brief-risk-chip-375-dark.png); `briefing-model.test.ts`, `Briefing.test.tsx`, `briefing.e2e.spec.ts` "files by risk (H4-10)"
- [x] Change map (P5-1/P5-3): lanes, cards coloured by delta, hero edges animated, edge labels, finding-count badges by worst severity, click card → file, legend. The renderer's map in the briefing ([brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png), [brief-1024-dark](../../apps/web/e2e/__screenshots__/brief-1024-dark.png), scrolling in its box at [brief-375-light](../../apps/web/e2e/__screenshots__/brief-375-light.png)); P5-3: a card opens its file and, beyond the POC, a finding badge opens its worst finding at its line ([file-at-finding-1440-light](../../apps/web/e2e/__screenshots__/file-at-finding-1440-light.png), [file-at-finding-375-dark](../../apps/web/e2e/__screenshots__/file-at-finding-375-dark.png)); cards and badges are keyboard buttons with a visible focus ring, which the POC lacked ([map-focus-card-1024-light](../../apps/web/e2e/__screenshots__/map-focus-card-1024-light.png), [map-focus-badge-1440-dark](../../apps/web/e2e/__screenshots__/map-focus-badge-1440-dark.png)); `e2e/change-map.e2e.spec.ts`. The hero animation is paused in screenshots (`animations: "disabled"`)
- [ ] Change map unavailable (H2 #2, not in the POC): when the document has no `graph`, the rest of the briefing still renders and the map area shows "Change map unavailable", the reason from `provenance.graphUnavailable` (none when the field is absent) and a Retry button. P6-2: all but Retry ([brief-map-unavailable-1440-light](../../apps/web/e2e/__screenshots__/brief-map-unavailable-1440-light.png), [brief-map-unavailable-375-dark](../../apps/web/e2e/__screenshots__/brief-map-unavailable-375-dark.png)); Retry needs a server endpoint (see `docs/progress.md`, P6-2 follow-ups)
- [x] Suggested review path: numbered, file + why + score, clickable. H4-11: removed (see Intentional differences); the document's path still orders "Start with the riskiest file", k and j — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png), [brief-375-dark](../../apps/web/e2e/__screenshots__/brief-375-dark.png); `Briefing.test.tsx` "has no suggested review path section (H4-11)"
- [x] "Project memory applied" list with source PR — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png); "Not available without the AI briefing." when Rocky wrote the briefing ([brief-by-rocky-1440-light](../../apps/web/e2e/__screenshots__/brief-by-rocky-1440-light.png))
- [x] "AI checked, looks fine" list — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png); the same "Not available" line when Rocky wrote the briefing
- [x] "Start with the riskiest file (k)" button — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png); the `k` hint since P6-5 (shown when k opens that same file)
- [x] Analysis states (P6-2, not in the POC), with the sidebar's "Files appear here once the analysis is ready": no analysis yet [brief-none-1440-light](../../apps/web/e2e/__screenshots__/brief-none-1440-light.png), analysing (a live status) [brief-running-1440-light](../../apps/web/e2e/__screenshots__/brief-running-1440-light.png), waiting for approval with the token estimate and limit [brief-awaiting-approval-1440-dark](../../apps/web/e2e/__screenshots__/brief-awaiting-approval-1440-dark.png), failed with plain words and the fixed code [brief-failed-1440-light](../../apps/web/e2e/__screenshots__/brief-failed-1440-light.png), out of date (`superseded`) [brief-superseded-375-light](../../apps/web/e2e/__screenshots__/brief-superseded-375-light.png); a previous briefing under a banner while the latest push is re-analysed [brief-reanalysing-1440-light](../../apps/web/e2e/__screenshots__/brief-reanalysing-1440-light.png) or when the document is of an earlier commit than the head [brief-out-of-date-375-dark](../../apps/web/e2e/__screenshots__/brief-out-of-date-375-dark.png); every state at 375/1024/1440 × light/dark in the same folder

## File view (P6-3)

- [x] P6-3 · Sticky header: risk label + score, path, +/−, "Mark viewed (v)" / "✓ Viewed" — [file-critical-1440-light](../../apps/web/e2e/__screenshots__/file-critical-1440-light.png), [file-critical-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-1440-dark.png); the `v` hint and key since P6-5
- [x] P6-3 · AI strip: "What changed", "Why <level>", "Drafts: n findings" — [file-critical-1440-light](../../apps/web/e2e/__screenshots__/file-critical-1440-light.png), [file-critical-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-1440-dark.png); "Accept, edit or dismiss each one inline" added with the inline drafts (P6-4)
- [x] P6-3 · Hunk headers — [file-critical-1440-light](../../apps/web/e2e/__screenshots__/file-critical-1440-light.png), [file-critical-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-1440-dark.png); modified files: `diff.e2e.spec.ts` "a modified file shows old and new numbers, signs and hunk headers"
- [x] P6-3 · Old/new line numbers, +/− signs, add/del backgrounds — [file-pending-comment-1440-light](../../apps/web/e2e/__screenshots__/file-pending-comment-1440-light.png), [file-noise-raw-1024-light](../../apps/web/e2e/__screenshots__/file-noise-raw-1024-light.png) (removed lines); [file-critical-1440-light](../../apps/web/e2e/__screenshots__/file-critical-1440-light.png), [file-critical-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-1440-dark.png), `diff.e2e.spec.ts`
- [x] P6-3 · Syntax highlighting (keywords, strings, comments, numbers) — [file-critical-1440-light](../../apps/web/e2e/__screenshots__/file-critical-1440-light.png), [file-critical-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-1440-dark.png); tokenizer tests in `tokenize.test.ts` (ADR 0023)
- [x] P6-3 · Hot-line marker on the left edge coloured by severity / flag kind — [file-critical-end-1440-light](../../apps/web/e2e/__screenshots__/file-critical-end-1440-light.png), [file-critical-end-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-end-1440-dark.png); [file-critical-1440-light](../../apps/web/e2e/__screenshots__/file-critical-1440-light.png), [file-critical-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-1440-dark.png); `diff.e2e.spec.ts` "hot lines and AI flags sit on their lines"
- [x] P6-3 · AI flags under lines: "✦ Look here", "✦ Your call" (question for the reviewer), "✓ Checked" — [file-critical-end-1440-light](../../apps/web/e2e/__screenshots__/file-critical-end-1440-light.png), [file-critical-end-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-end-1440-dark.png); [file-critical-1440-light](../../apps/web/e2e/__screenshots__/file-critical-1440-light.png), [file-critical-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-1440-dark.png)
- [x] P6-3 · Click a new-line number → compose your own comment (Add / Cancel / "✦ Polish with AI", ⌘↵ to add) — [file-own-comment-1440-light](../../apps/web/e2e/__screenshots__/file-own-comment-1440-light.png), [file-own-comment-375-dark](../../apps/web/e2e/__screenshots__/file-own-comment-375-dark.png); keyboard path in `diff.e2e.spec.ts`. "✦ Polish with AI" is not built (see Intentional differences)
- [x] P6-3 · Your own pending comments inline with Delete — [file-pending-comment-1440-light](../../apps/web/e2e/__screenshots__/file-pending-comment-1440-light.png), [file-pending-comment-375-dark](../../apps/web/e2e/__screenshots__/file-pending-comment-375-dark.png); `diff.e2e.spec.ts` "arrows move between lines, Enter composes…"; kept on the server since P6-4 (`drafts.e2e.spec.ts` "own comments: add → refresh…")
- [x] P6-3 · Footer: "Mark viewed & next →" / "Next file →" — [file-critical-end-1440-light](../../apps/web/e2e/__screenshots__/file-critical-end-1440-light.png), [file-critical-end-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-end-1440-dark.png); [file-critical-1440-light](../../apps/web/e2e/__screenshots__/file-critical-1440-light.png), [file-critical-1440-dark](../../apps/web/e2e/__screenshots__/file-critical-1440-dark.png); `diff.e2e.spec.ts` "Mark viewed & next…"
- [x] P6-3 · Noise file view: AI summary + "Show raw diff" — [file-noise-raw-1024-light](../../apps/web/e2e/__screenshots__/file-noise-raw-1024-light.png); [file-noise-1440-light](../../apps/web/e2e/__screenshots__/file-noise-1440-light.png), [file-noise-375-dark](../../apps/web/e2e/__screenshots__/file-noise-375-dark.png); the raw diff really expands (the POC showed a toast)
- [x] P6-3 (not in the POC) · Large files are virtualised: a 5,000-line diff scrolls at 60 fps with the CPU throttled 4x (`diff.perf.spec.ts`, Chrome trace)
- [x] H4-3 (not in the POC) · The diff of a real PR comes from the server, and the file view says why it cannot when it cannot, in fixed words, with the way out (GitHub, or signing in again): loaded [real-pr-diff-1440-light](../../apps/web/e2e/__screenshots__/real-pr-diff-1440-light.png), only the first part of a long diff [real-pr-diff-truncated-375-dark](../../apps/web/e2e/__screenshots__/real-pr-diff-truncated-375-dark.png), not found [real-pr-diff-not-found-1024-light](../../apps/web/e2e/__screenshots__/real-pr-diff-not-found-1024-light.png), head moved [real-pr-diff-head-moved-375-light](../../apps/web/e2e/__screenshots__/real-pr-diff-head-moved-375-light.png), commits gone [real-pr-diff-commits-unavailable-1440-dark](../../apps/web/e2e/__screenshots__/real-pr-diff-commits-unavailable-1440-dark.png), too large [real-pr-diff-too-large-1024-light](../../apps/web/e2e/__screenshots__/real-pr-diff-too-large-1024-light.png), access unavailable [real-pr-diff-unavailable-1440-light](../../apps/web/e2e/__screenshots__/real-pr-diff-unavailable-1440-light.png), GitHub failed [real-pr-diff-failed-375-dark](../../apps/web/e2e/__screenshots__/real-pr-diff-failed-375-dark.png), rate limited [real-pr-diff-rate-limited-1024-dark](../../apps/web/e2e/__screenshots__/real-pr-diff-rate-limited-1024-dark.png), signed out [real-pr-diff-signed-out-1440-light](../../apps/web/e2e/__screenshots__/real-pr-diff-signed-out-1440-light.png); every state at 375/1024/1440 × light/dark in the same folder

## AI drafts (P6-4)

- [x] Draft card: "✦ AI draft", severity pill, confidence %, "Only you can see this until you accept it" — [drafts-card-1440-light](../../apps/web/e2e/__screenshots__/drafts-card-1440-light.png), [drafts-card-375-dark](../../apps/web/e2e/__screenshots__/drafts-card-375-dark.png); `DraftCard.test.tsx`
- [x] Title, body (inline code), suggested-change mini diff (with optional context line) — [drafts-card-1440-dark](../../apps/web/e2e/__screenshots__/drafts-card-1440-dark.png); the "−" lines are the range's lines from the diff
- [x] Project-memory evidence line with source — `DraftCard.test.tsx` "shows the project-memory evidence"; on screen for F2 ([drafts-card-1024-light](../../apps/web/e2e/__screenshots__/drafts-card-1024-light.png) shows F1, which cites none)
- [x] Double-check line when a dismissal covered the draft but the file is critical (P8-2, not in the POC) — `DraftCard.test.tsx` "says when a dismissal covered the draft"; on screen for F3 ([drafts-double-check-1024-light](../../apps/web/e2e/__screenshots__/drafts-double-check-1024-light.png), [dark](../../apps/web/e2e/__screenshots__/drafts-double-check-1024-dark.png))
- [x] "N findings hidden by memory · show" under a file's AI strip, collapsed (P8-2b, not in the POC) — `FileView.test.tsx` "a file with findings hidden by memory shows one collapsed line"; [drafts-hidden-1440-light](../../apps/web/e2e/__screenshots__/drafts-hidden-1440-light.png), [drafts-hidden-1024-dark](../../apps/web/e2e/__screenshots__/drafts-hidden-1024-dark.png), [drafts-hidden-375-light](../../apps/web/e2e/__screenshots__/drafts-hidden-375-light.png), [drafts-hidden-375-dark](../../apps/web/e2e/__screenshots__/drafts-hidden-375-dark.png)
- [x] Expanded: the hidden finding as an AI card that is not a draft (dashed, "AI finding", severity, confidence, "Hidden by project memory"), the dismissal that hid it, "Restore as a draft" (P8-2b) — `HiddenCard.test.tsx`; [drafts-hidden-open-1440-light](../../apps/web/e2e/__screenshots__/drafts-hidden-open-1440-light.png), [drafts-hidden-open-1024-dark](../../apps/web/e2e/__screenshots__/drafts-hidden-open-1024-dark.png), [drafts-hidden-open-375-light](../../apps/web/e2e/__screenshots__/drafts-hidden-open-375-light.png), [drafts-hidden-open-375-dark](../../apps/web/e2e/__screenshots__/drafts-hidden-open-375-dark.png); keyboard path and restore in `drafts.e2e.spec.ts` "hidden by memory (P8-2b)"; axe in "drafts in every state"
- [x] Review panel: "Hidden by memory" section, collapsed, items open the file on the list (P8-2b) — `ReviewPanel.test.tsx`; [drafts-panel-end-1440-light](../../apps/web/e2e/__screenshots__/drafts-panel-end-1440-light.png), [drafts-panel-end-375-dark](../../apps/web/e2e/__screenshots__/drafts-panel-end-375-dark.png); expanded, items with the "hidden" badge: [drafts-panel-hidden-open-1440-light](../../apps/web/e2e/__screenshots__/drafts-panel-hidden-open-1440-light.png), [drafts-panel-hidden-open-1024-dark](../../apps/web/e2e/__screenshots__/drafts-panel-hidden-open-1024-dark.png), [drafts-panel-hidden-open-375-light](../../apps/web/e2e/__screenshots__/drafts-panel-hidden-open-375-light.png)
- [x] A restored draft under its line, with "Your team dismissed this as … Rocky had hidden it; you restored it." and the usual actions (P8-2b) — `DraftCard.test.tsx` "a draft restored from the hidden list says which dismissal had hidden it"; [drafts-restored-1440-light](../../apps/web/e2e/__screenshots__/drafts-restored-1440-light.png), [drafts-restored-1024-dark](../../apps/web/e2e/__screenshots__/drafts-restored-1024-dark.png), [drafts-restored-375-light](../../apps/web/e2e/__screenshots__/drafts-restored-375-light.png), [drafts-restored-375-dark](../../apps/web/e2e/__screenshots__/drafts-restored-375-dark.png)
- [x] Accept (a) → becomes "@login · Pending · from AI draft" with Undo (the reviewer's login since P6-9, "you" until the session loads; it read "You": [audit D10](parity-audit.md)) — [drafts-accepted-1440-light](../../apps/web/e2e/__screenshots__/drafts-accepted-1440-light.png), [drafts-accepted-375-light](../../apps/web/e2e/__screenshots__/drafts-accepted-375-light.png); kept on the server (`drafts.e2e.spec.ts` "accept → refresh…"); `a` key and hint since P6-5 [keys-accept-focus-1440-light](../../apps/web/e2e/__screenshots__/keys-accept-focus-1440-light.png)
- [x] Edit (e) → textarea → "Save as my comment" → "edited from AI draft" — [drafts-edit-1440-light](../../apps/web/e2e/__screenshots__/drafts-edit-1440-light.png), [drafts-edit-375-dark](../../apps/web/e2e/__screenshots__/drafts-edit-375-dark.png); ⌘/Ctrl+Enter saves, Escape cancels; `e` since P6-5
- [x] Dismiss (d) → reason chips (Not a real issue / Intentional / Not worth it here / Already handled elsewhere / Cancel) → collapsed "dismissed (reason)" with Undo — [drafts-dismiss-1440-dark](../../apps/web/e2e/__screenshots__/drafts-dismiss-1440-dark.png), [drafts-dismissed-1024-dark](../../apps/web/e2e/__screenshots__/drafts-dismissed-1024-dark.png); the reason is stored as a fixed code for P8; `d` since P6-5
- [x] "Send to agent ↗" copies a fix prompt (toast) — `drafts.e2e.spec.ts` "send to agent copies the fix prompt…" (clipboard checked); the copy is recorded and shown as "✓ Fix prompt copied" after a reload
- [x] Focus ring on the focused draft (n/p; i/u since H4-14) — [drafts-dismiss-1440-light](../../apps/web/e2e/__screenshots__/drafts-dismiss-1440-light.png); set by acting on a draft or jumping to it from the panel (`drafts.e2e.spec.ts` "an item jumps to its draft…"); and by `n`/`p` since P6-5 ([keys-draft-focus-1440-dark](../../apps/web/e2e/__screenshots__/keys-draft-focus-1440-dark.png), [keys-draft-focus-375-light](../../apps/web/e2e/__screenshots__/keys-draft-focus-375-light.png))

## Right panel

- [x] P6-4 · Review tab with count of undecided drafts — [drafts-panel-1440-light](../../apps/web/e2e/__screenshots__/drafts-panel-1440-light.png)
- [x] P6-4 · Tally: AI drafts to decide / Your comments / Dismissed — [drafts-panel-1440-light](../../apps/web/e2e/__screenshots__/drafts-panel-1440-light.png), drawer [drafts-panel-375-dark](../../apps/web/e2e/__screenshots__/drafts-panel-375-dark.png)
- [x] P6-4 · "To decide · by severity" list, then "Decided", item → jumps to the draft (H4-14: "To decide", the open file's drafts first under "This file", then "Other files", each by severity; one plain list on the briefing or when only one group has drafts; the "✦ draft" badge is gone and the severity shows as the card's pill, a little larger — [keys-draft-focus-1440-light](../../apps/web/e2e/__screenshots__/keys-draft-focus-1440-light.png), [drafts-panel-1440-dark](../../apps/web/e2e/__screenshots__/drafts-panel-1440-dark.png), `ReviewPanel.test.tsx` "H4-14: …", `keyboard.e2e.spec.ts` "H4-14: To decide lists this file's drafts first…") — [drafts-panel-1024-light](../../apps/web/e2e/__screenshots__/drafts-panel-1024-light.png); the jump opens the file and focuses the draft, closing the drawer below 1180 px (`drafts.e2e.spec.ts`); defect 2 (clipped badge) fixed
- [x] P6-4 · "Rocky will remember n dismissals" note (P8-2) — [drafts-panel-end-1440-dark](../../apps/web/e2e/__screenshots__/drafts-panel-end-1440-dark.png), drawer [drafts-panel-end-375-light](../../apps/web/e2e/__screenshots__/drafts-panel-end-375-light.png); worded "Rocky keeps the reason for n dismissals…" until P8 learns from them (Intentional differences)
- [x] P6-4 · "Your own comments" list → jumps to the line — [drafts-panel-end-1440-light](../../apps/web/e2e/__screenshots__/drafts-panel-end-1440-light.png); own comments are now kept on the server too
- [x] P9-2 · Ask tab: empty-state hint, suggested questions, chat bubbles, "Reading the code…" typing state, answers with clickable `file:line` citations, Enter to send — [ask-ready-1440-light](../../apps/web/e2e/__screenshots__/ask-ready-1440-light.png), [ask-answer-1440-light](../../apps/web/e2e/__screenshots__/ask-answer-1440-light.png), [ask-answers-1440-dark](../../apps/web/e2e/__screenshots__/ask-answers-1440-dark.png), [ask-answering-1024-light](../../apps/web/e2e/__screenshots__/ask-answering-1024-light.png), [ask-no-answer-1440-dark](../../apps/web/e2e/__screenshots__/ask-no-answer-1440-dark.png), [ask-error-375-light](../../apps/web/e2e/__screenshots__/ask-error-375-light.png), [ask-not-indexed-1024-dark](../../apps/web/e2e/__screenshots__/ask-not-indexed-1024-dark.png), [ask-indexing-375-dark](../../apps/web/e2e/__screenshots__/ask-indexing-375-dark.png); `ask.e2e.spec.ts` "Enter asks; the answer links each cited range at the indexed commit", "the Ask button and a suggestion ask too"
- [x] P9-3 · Ask limit states: the member's limit and the organisation's budget as distinct alerts with the wait, Try again and Ask disabled until it has passed (no POC counterpart) — [ask-rate-limited-375-light](../../apps/web/e2e/__screenshots__/ask-rate-limited-375-light.png), [ask-rate-limited-1440-dark](../../apps/web/e2e/__screenshots__/ask-rate-limited-1440-dark.png), [ask-org-limited-1024-light](../../apps/web/e2e/__screenshots__/ask-org-limited-1024-light.png), [ask-org-limited-1440-dark](../../apps/web/e2e/__screenshots__/ask-org-limited-1440-dark.png); `ask.e2e.spec.ts` "the member's limit…", "the org's limit…"
- [x] P6-5 · Shortcut strip at the bottom of the Review tab — [drafts-panel-1440-light](../../apps/web/e2e/__screenshots__/drafts-panel-1440-light.png), [keys-help-1440-light](../../apps/web/e2e/__screenshots__/keys-help-1440-light.png); "/ ask" joins it with Ask (P9-2), "? all shortcuts" added; says when single-key shortcuts are off; H4-14: reads "j/k previous & next file" and "u/i previous & next AI draft", a/e/d only while the focused draft is on screen ([drafts-panel-1440-light](../../apps/web/e2e/__screenshots__/drafts-panel-1440-light.png), [keys-draft-focus-1440-dark](../../apps/web/e2e/__screenshots__/keys-draft-focus-1440-dark.png))

## Finish review modal (P6-6)

All in `finish.e2e.spec.ts` and `FinishReview.test.tsx` unless noted; rules in
[ADR 0031](../adr/0031-finish-review-modal.md).

- [x] Warning: high-risk files not marked viewed (names) — [finish-1440-light](../../apps/web/e2e/__screenshots__/finish-1440-light.png), [finish-1024-dark](../../apps/web/e2e/__screenshots__/finish-1024-dark.png); full paths (the POC's base names collide: two `invitations.ts`) ("coverage and undecided warnings, then the success line")
- [x] Success state: all Critical/Important reviewed — [finish-covered-1440-light](../../apps/web/e2e/__screenshots__/finish-covered-1440-light.png), [finish-covered-375-dark](../../apps/web/e2e/__screenshots__/finish-covered-375-dark.png)
- [x] Warning: n AI drafts undecided, won't be posted — [finish-1440-light](../../apps/web/e2e/__screenshots__/finish-1440-light.png)
- [x] Exact list "Will be posted to GitHub as @you (n)" — [finish-covered-1440-light](../../apps/web/e2e/__screenshots__/finish-covered-1440-light.png); the server's list (P3-5 `GET …/review`), each body shown as its Markdown source (the POC showed titles only): "the modal lists exactly the server's plan… and the click posts exactly it"
- [x] Overall comment textarea + "✦ Draft a summary from my comments" — [finish-covered-1440-light](../../apps/web/e2e/__screenshots__/finish-covered-1440-light.png); the draft is composed from the items to post, no model call, and is a suggestion the person edits or clears
- [x] Verdict: Comment / Approve / Request changes; Request changes pre-selected (with reason) when a critical/high finding was accepted — [finish-1440-light](../../apps/web/e2e/__screenshots__/finish-1440-light.png); Comment is suggested when there is something to post, Approve is suggested but **never pre-selected** (the POC pre-selected it; an approval is the person's pick), and Submit is off until a verdict is picked; since P6-9 the suggested verdict and Submit are in view when the modal opens (the list scrolls in its own box: [audit D3](parity-audit.md), `finish.e2e.spec.ts` "the modal fits")
- [x] Keep reviewing / Submit review → toast + status pill updates — [finish-posted-1440-light](../../apps/web/e2e/__screenshots__/finish-posted-1440-light.png), [finish-posted-375-dark](../../apps/web/e2e/__screenshots__/finish-posted-375-dark.png); the posted drafts and comments then read "Posted" and lose Undo / Delete
- [x] (not in the POC) Every server answer in words: stale / new commits reload the list, GitHub's refusal with its reason, a lost or unusable answer says the review may exist and links to GitHub ("every answer is shown honestly and posts nothing by itself") — [finish-failed-1440-light](../../apps/web/e2e/__screenshots__/finish-failed-1440-light.png), [finish-unknown-1440-light](../../apps/web/e2e/__screenshots__/finish-unknown-1440-light.png), [finish-sending-1440-light](../../apps/web/e2e/__screenshots__/finish-sending-1440-light.png), [finish-verdict-375-light](../../apps/web/e2e/__screenshots__/finish-verdict-375-light.png)
- [x] (not in the POC) Invisible characters in a comment (bidi overrides, zero-width spaces) are shown as `U+…` markers with a warning ("invisible characters… show as markers and are named")

## Keyboard (P6-5)

All in `keyboard.e2e.spec.ts` "a full review with the keyboard only" unless noted; rules in
[ADR 0030](../adr/0030-keyboard-shortcuts.md).

- [x] k next file, j previous file (risk order, noise included) — j from the first file returns to the briefing; a noise file opens the noise group ("j on the first file…")
- [x] n / p next / previous draft (undecided first; H4-14: i / u, in the Review panel's order, n and p do nothing — "H4-14: n and p do nothing now…", "H4-14: To decide lists this file's drafts first, and i/u follow it"); like the panel's items, nothing while the review state loads or on a diff from a newer push ("on a diff from a newer push…") — [keys-draft-focus-1440-light](../../apps/web/e2e/__screenshots__/keys-draft-focus-1440-light.png), [keys-draft-focus-1024-dark](../../apps/web/e2e/__screenshots__/keys-draft-focus-1024-dark.png), [keys-draft-focus-375-dark](../../apps/web/e2e/__screenshots__/keys-draft-focus-375-dark.png)
- [x] a accept, e edit, d dismiss (focused draft in the current file; H4-14: only while it is on screen, and only then its hints on the card and in the strip — "H4-14: a, e and d act only while the focused draft is on screen…", [keys-draft-focus-1440-light](../../apps/web/e2e/__screenshots__/keys-draft-focus-1440-light.png)) — [keys-accept-focus-1440-dark](../../apps/web/e2e/__screenshots__/keys-accept-focus-1440-dark.png), [keys-accept-focus-375-light](../../apps/web/e2e/__screenshots__/keys-accept-focus-375-light.png); they press the card's own buttons, so its guards apply, and do nothing while the drafts are hidden or the card is being edited or dismissed ("a, e and d act only on the focused draft…", "while a draft is being dismissed or edited…")
- [x] v toggle viewed
- [x] H4-14 · 1–4 pick a dismiss reason while the reasons are shown (not in the POC), each reason with its key — [drafts-dismiss-1440-light](../../apps/web/e2e/__screenshots__/drafts-dismiss-1440-light.png), [drafts-dismiss-1024-dark](../../apps/web/e2e/__screenshots__/drafts-dismiss-1024-dark.png), "H4-14: 1–4 pick a dismiss reason…"
- [x] H4-14 · ↑/↓ scroll the open file (not in the POC): with nothing focused they scroll the main column; a file picked in the sidebar with the mouse takes focus, so they scroll it natively; a focused diff line keeps moving the active line — "H4-14: ↑/↓ scroll the open file"
- [x] / open Ask, pre-filled with selected code (P9-2: the selection is attached as a removable chip, not pasted into the box) — [ask-selection-1440-light](../../apps/web/e2e/__screenshots__/ask-selection-1440-light.png), [ask-selection-375-dark](../../apps/web/e2e/__screenshots__/ask-selection-375-dark.png); `ask.e2e.spec.ts` "attaches the selection and focuses the box at 375/1024/1440 px", `keyboard.e2e.spec.ts`
- [x] b back to briefing
- [x] H4-12 · t change tree (not in the POC), listed in the dialog as "Change tree: what changed where"; typing t in a text field types it — `keymap.test.ts`, `change-tree.e2e.spec.ts` "t opens the tree…", "t types in a comment box…", [keys-help-1440-light](../../apps/web/e2e/__screenshots__/keys-help-1440-light.png)
- [x] m toggle light/dark
- [x] ? shortcuts dialog — [keys-help-1440-light](../../apps/web/e2e/__screenshots__/keys-help-1440-light.png), [keys-help-1440-dark](../../apps/web/e2e/__screenshots__/keys-help-1440-dark.png), [keys-help-1024-light](../../apps/web/e2e/__screenshots__/keys-help-1024-light.png), [keys-help-1024-dark](../../apps/web/e2e/__screenshots__/keys-help-1024-dark.png), [keys-help-375-light](../../apps/web/e2e/__screenshots__/keys-help-375-light.png), [keys-help-375-dark](../../apps/web/e2e/__screenshots__/keys-help-375-dark.png); focus trap, Escape, click outside, axe 0 serious ("the shortcuts dialog")
- [x] ⌘↵ open Finish review; Esc closes dialogs / cancels edit, dismiss, compose — ⌘/Ctrl+Enter opens the Finish review modal (P6-6), Esc closes it (never while the review is being sent) and the dialog, drawers, edit, dismiss and compose; "a full review with the keyboard only" now ends with the review submitted
- [x] Shortcuts ignored while typing in a text field — composer, draft editor and contenteditable ("shortcuts never fire while typing"); also with Ctrl/⌘/Alt ("shortcuts respect modifiers")
- [x] (not in the POC) Single-key shortcuts can be turned off (WCAG 2.1.4), remembered per browser — [keys-help-off-1440-light](../../apps/web/e2e/__screenshots__/keys-help-off-1440-light.png), [keys-help-off-375-dark](../../apps/web/e2e/__screenshots__/keys-help-off-375-dark.png)

## Feedback

- [ ] P6-4 · Toasts: accepted ("not posted yet"), agent prompt copied, noise trusted, "✦ Polished" after Polish with AI, review submitted. P6-4: accepted ([drafts-accepted-1440-light](../../apps/web/e2e/__screenshots__/drafts-accepted-1440-light.png)), agent prompt copied and noise trusted (`drafts.e2e.spec.ts`), plus failure and conflict messages; P6-6: "Review submitted to GitHub as @login." ([finish-posted-1440-light](../../apps/web/e2e/__screenshots__/finish-posted-1440-light.png)) and "already posted" when a posted item is touched; "Polished" waits for Polish with AI

## Responsive

- [x] P6-1 · < 1180 px: right panel hidden (the real app must offer it another way, see defects) — [pr-shell-1024-light](../../apps/web/e2e/__screenshots__/pr-shell-1024-light.png), drawer: [pr-panel-drawer-1024-light](../../apps/web/e2e/__screenshots__/pr-panel-drawer-1024-light.png)
- [x] P6-1 · < 760 px: sidebar hidden, secondary top-bar items hidden — [pr-shell-375-light](../../apps/web/e2e/__screenshots__/pr-shell-375-light.png), drawer: [pr-files-drawer-375-dark](../../apps/web/e2e/__screenshots__/pr-files-drawer-375-dark.png)

## Inbox (P6-7, not in the POC)

The POC has no inbox; it follows the POC's top bar, cards, pills, dots and modal.

- [x] PRs across repositories, one row each: risk pill, title (links to the PR page), repo + `#number`, author, +/−, updated N ago, finding dots, review estimate — [inbox-1440-light](../../apps/web/e2e/__screenshots__/inbox-1440-light.png), [inbox-1440-dark](../../apps/web/e2e/__screenshots__/inbox-1440-dark.png), [inbox-375-light](../../apps/web/e2e/__screenshots__/inbox-375-light.png)
- [x] Sorted by risk: critical, high, medium, not analysed, low (then findings, then longest waiting) — [inbox-1024-light](../../apps/web/e2e/__screenshots__/inbox-1024-light.png); `inbox.e2e.spec.ts` "lists open PRs across repositories, riskiest first"
- [x] Analysis states on the row (analysing, failed, out of date) and why a low-risk PR is not offered (findings, your own PR) — [inbox-1024-dark](../../apps/web/e2e/__screenshots__/inbox-1024-dark.png); `inbox.e2e.spec.ts` "states why a PR has no current analysis…"
- [x] Filters: repository, risk, search (title, repo, `#number`), "Showing n of m", Clear filters, empty state — [inbox-filtered-empty-1440-light](../../apps/web/e2e/__screenshots__/inbox-filtered-empty-1440-light.png), [inbox-filtered-empty-375-dark](../../apps/web/e2e/__screenshots__/inbox-filtered-empty-375-dark.png); `inbox.e2e.spec.ts` "filters"
- [x] "✦ Safe to bulk-approve" group (Rocky's suggestion, AI edge colour), nothing selected on load, Select all / Clear selection — [inbox-selected-1440-light](../../apps/web/e2e/__screenshots__/inbox-selected-1440-light.png), [inbox-selected-1024-dark](../../apps/web/e2e/__screenshots__/inbox-selected-1024-dark.png)
- [x] Explicit confirmation per batch: dialog lists the exact PRs and commits, Cancel focused first, Escape/Cancel send nothing, confirm inert for 600 ms after opening (a double-click on the opener never confirms), one request per confirm — [inbox-confirm-1440-light](../../apps/web/e2e/__screenshots__/inbox-confirm-1440-light.png), [inbox-confirm-375-dark](../../apps/web/e2e/__screenshots__/inbox-confirm-375-dark.png); `inbox.e2e.spec.ts` "bulk approval needs an explicit confirmation per batch"
- [x] Outcome: approved, partly failed, refused (changed since you looked), unavailable; afterwards the approved PRs leave the group, a status line says so and focus stays on the group — [inbox-approved-1440-light](../../apps/web/e2e/__screenshots__/inbox-approved-1440-light.png), [inbox-approved-375-dark](../../apps/web/e2e/__screenshots__/inbox-approved-375-dark.png), [inbox-refused-1440-light](../../apps/web/e2e/__screenshots__/inbox-refused-1440-light.png), [inbox-refused-375-dark](../../apps/web/e2e/__screenshots__/inbox-refused-375-dark.png), [inbox-after-approval-1440-light](../../apps/web/e2e/__screenshots__/inbox-after-approval-1440-light.png), [inbox-after-approval-375-dark](../../apps/web/e2e/__screenshots__/inbox-after-approval-375-dark.png); `inbox.e2e.spec.ts`
- [x] Keyboard path (filters → select → confirm → Close, focus kept) and axe 0 serious at 375/1024/1440 × light/dark in every state (selected, dialog, outcome, after closing, filtered empty); selection checkboxes in indigo with a 3:1 border; no horizontal scroll at 375 px — `inbox.e2e.spec.ts` "keyboard", "axe and layout"

## Project memory (P8-3, not in the POC)

The POC has no memory page (only "manage this in Project memory" in its finish modal); it
follows the inbox's frame and the POC's cards, pills, memory mark (◆), AI mark (✦) and modal.

- [x] Entries of one repository with kind, dismissal reason and what it covers, origin (✦ learned / written by a member), evidence (path, lines, short sha), source PR link, confidence, last used, who taught it ("former member") — [memory-1440-light](../../apps/web/e2e/__screenshots__/memory-1440-light.png), [memory-1440-dark](../../apps/web/e2e/__screenshots__/memory-1440-dark.png), [memory-375-light](../../apps/web/e2e/__screenshots__/memory-375-light.png)
- [x] Switched-off and earlier-version states; filter by kind, "Show earlier versions" — [memory-history-1024-light](../../apps/web/e2e/__screenshots__/memory-history-1024-light.png), [memory-history-375-dark](../../apps/web/e2e/__screenshots__/memory-history-375-dark.png)
- [x] Edit inline (kind, reason, text; Escape cancels) — [memory-edit-1440-light](../../apps/web/e2e/__screenshots__/memory-edit-1440-light.png), [memory-edit-375-dark](../../apps/web/e2e/__screenshots__/memory-edit-375-dark.png); `memory.e2e.spec.ts` "keyboard"
- [x] Delete asks first (POC modal; Cancel focused, says how many earlier versions go with it) — [memory-delete-1024-light](../../apps/web/e2e/__screenshots__/memory-delete-1024-light.png), [memory-delete-375-dark](../../apps/web/e2e/__screenshots__/memory-delete-375-dark.png)
- [x] Memory on/off for the repository, with the "Memory is off" banner — [memory-off-1440-dark](../../apps/web/e2e/__screenshots__/memory-off-1440-dark.png), [memory-off-375-light](../../apps/web/e2e/__screenshots__/memory-off-375-light.png)
- [x] A member's view: no controls — [memory-member-1440-light](../../apps/web/e2e/__screenshots__/memory-member-1440-light.png), [memory-member-375-dark](../../apps/web/e2e/__screenshots__/memory-member-375-dark.png)
- [x] Empty repository — [memory-empty-1024-dark](../../apps/web/e2e/__screenshots__/memory-empty-1024-dark.png)
- [x] Export `context.md` (a download from the server) — `memory.e2e.spec.ts` "the export is a context.md download from the server"
- [ ] A link to the page from the briefing's "Project memory applied" (follow-up, see `docs/progress.md` P8-3)

## Setup wizard (P10-2, not in the POC)

The POC has no setup page; it follows the inbox's frame and the POC's top bar, cards, status
pills and buttons (indigo for the person's actions, the AI mark on the LLM step).

- [x] Four step cards (Database, GitHub App, LLM provider, First repository), each with a numbered badge (a check when done) and a Done / To do / Needs attention / Waiting pill — [setup-fresh-1440-light](../../apps/web/e2e/__screenshots__/setup-fresh-1440-light.png), [setup-fresh-1440-dark](../../apps/web/e2e/__screenshots__/setup-fresh-1440-dark.png), [setup-fresh-375-light](../../apps/web/e2e/__screenshots__/setup-fresh-375-light.png), [setup-fresh-1024-dark](../../apps/web/e2e/__screenshots__/setup-fresh-1024-dark.png)
- [x] GitHub App created: restart first, install after, with the Compose commands — [setup-created-1440-light](../../apps/web/e2e/__screenshots__/setup-created-1440-light.png), [setup-created-375-dark](../../apps/web/e2e/__screenshots__/setup-created-375-dark.png)
- [x] LLM test call: each model with its roles and its answer and duration (`setup.e2e.spec.ts` "the test call posts with the CSRF token…") — [setup-created-1024-light](../../apps/web/e2e/__screenshots__/setup-created-1024-light.png), [setup-failures-1024-light](../../apps/web/e2e/__screenshots__/setup-failures-1024-light.png)
- [x] First repository: install link, per-account counts, then the first analysed pull request linked into Rocky — [setup-installed-1440-light](../../apps/web/e2e/__screenshots__/setup-installed-1440-light.png), [setup-installed-375-dark](../../apps/web/e2e/__screenshots__/setup-installed-375-dark.png), [setup-done-1440-dark](../../apps/web/e2e/__screenshots__/setup-done-1440-dark.png), [setup-done-375-dark](../../apps/web/e2e/__screenshots__/setup-done-375-dark.png)
- [x] Failures named with what to do (migrations, webhook URL, provider errors) — [setup-failures-1440-light](../../apps/web/e2e/__screenshots__/setup-failures-1440-light.png), [setup-failures-1440-dark](../../apps/web/e2e/__screenshots__/setup-failures-1440-dark.png), [setup-failures-375-light](../../apps/web/e2e/__screenshots__/setup-failures-375-light.png)
- [x] Finish setup and the closed page — [setup-finished-1440-light](../../apps/web/e2e/__screenshots__/setup-finished-1440-light.png), [setup-finished-375-dark](../../apps/web/e2e/__screenshots__/setup-finished-375-dark.png); keyboard path and axe 0 serious at every width and mode (`setup.e2e.spec.ts`)
- [x] Fix round: not installed yet, and accounts waiting for GitHub's event or suspended — [setup-not-installed-1024-light](../../apps/web/e2e/__screenshots__/setup-not-installed-1024-light.png), [setup-accounts-1440-dark](../../apps/web/e2e/__screenshots__/setup-accounts-1440-dark.png), [setup-accounts-375-light](../../apps/web/e2e/__screenshots__/setup-accounts-375-light.png)
- [x] Fix round: an invalid LLM configuration, a test call in flight (buttons busy but focusable), too soon, a failed finish — [setup-invalid-llm-1440-light](../../apps/web/e2e/__screenshots__/setup-invalid-llm-1440-light.png), [setup-testing-1024-light](../../apps/web/e2e/__screenshots__/setup-testing-1024-light.png), [setup-too-soon-375-dark](../../apps/web/e2e/__screenshots__/setup-too-soon-375-dark.png), [setup-finish-failed-1440-dark](../../apps/web/e2e/__screenshots__/setup-finish-failed-1440-dark.png)
- [x] Fix round: a failed check keeps the last status with an inline alert; the refusal pages — [setup-check-failed-1440-dark](../../apps/web/e2e/__screenshots__/setup-check-failed-1440-dark.png), [setup-no-session-375-light](../../apps/web/e2e/__screenshots__/setup-no-session-375-light.png), [setup-closed-1024-dark](../../apps/web/e2e/__screenshots__/setup-closed-1024-dark.png), [setup-load-failed-1440-light](../../apps/web/e2e/__screenshots__/setup-load-failed-1440-light.png)
- [x] Fix round: announcements go to a hidden live region that clears itself, so the steps never move (`setup.e2e.spec.ts` "the announcement does not move the steps"); focus stays on busy buttons and lands on the finished message ("the keyboard alone…", Tab only)

## Token mode (P10-4, not in the POC)

The POC has none of these; they follow the inbox's frame and the setup wizard's cards, pills,
buttons and the inbox's confirmation modal (indigo for the person's actions, warnings on the
medium tint with text in `--text`).

- [x] App-mode wizard: "Create the GitHub App" first, the personal-token alternative collapsed under it, with its trade-offs and how to switch — [setup-app-token-alternative-1440-light](../../apps/web/e2e/__screenshots__/setup-app-token-alternative-1440-light.png), [setup-app-token-alternative-375-dark](../../apps/web/e2e/__screenshots__/setup-app-token-alternative-375-dark.png)
- [x] Token-mode wizard: how to create a fine-grained token, a password field that is emptied on submit, refusals by code; then the saved token (owner, kind, expiry, warnings) and "Add repositories" — [setup-token-required-1024-light](../../apps/web/e2e/__screenshots__/setup-token-required-1024-light.png), [setup-token-required-375-dark](../../apps/web/e2e/__screenshots__/setup-token-required-375-dark.png), [setup-token-connected-1440-light](../../apps/web/e2e/__screenshots__/setup-token-connected-1440-light.png), [setup-token-connected-375-dark](../../apps/web/e2e/__screenshots__/setup-token-connected-375-dark.png)
- [x] Connection page: token card (replace, remove with confirmation), followed repositories (stop following with confirmation), repository picker with a filter, Sync now with its outcome — [connection-1440-light](../../apps/web/e2e/__screenshots__/connection-1440-light.png), [connection-1024-dark](../../apps/web/e2e/__screenshots__/connection-1024-dark.png), [connection-classic-empty-375-dark](../../apps/web/e2e/__screenshots__/connection-classic-empty-375-dark.png), [connection-picker-1440-light](../../apps/web/e2e/__screenshots__/connection-picker-1440-light.png), [connection-picker-375-dark](../../apps/web/e2e/__screenshots__/connection-picker-375-dark.png)
- [x] Inbox sync bar: last synced, Sync, syncing (re-checked every 3 s, at most 10 times), problems as an alert with the way to replace the token — [inbox-sync-running-1440-light](../../apps/web/e2e/__screenshots__/inbox-sync-running-1440-light.png), [inbox-sync-running-375-dark](../../apps/web/e2e/__screenshots__/inbox-sync-running-375-dark.png), [inbox-sync-rate-limited-1024-light](../../apps/web/e2e/__screenshots__/inbox-sync-rate-limited-1024-light.png), [inbox-sync-rate-limited-375-light](../../apps/web/e2e/__screenshots__/inbox-sync-rate-limited-375-light.png)
- [x] Keyboard path (picker add, sync, replace, remove with confirm; dialogs close on Escape and give focus back), the token never in the DOM, axe 0 serious at 375/1024/1440 × light/dark — `connection.e2e.spec.ts`

## Known POC defects (do NOT copy)

Found while capturing the P0-8 screenshots.

1. **375 px overflows horizontally**: briefing text, risk table and the Finish button are cut off. The real app must have no horizontal page scroll at 375 px (risk table stacks, change map scrolls inside its own box).
2. **Right-panel "draft" badge is clipped** ("dra", "draf") when titles wrap. Reserve space or wrap the badge.
3. **Change-map edge labels overlap cards** ("POST /accept", "read token", "grant role"). P5-1 must place labels in free space. Done in the renderer (P5-1): labels are pills placed clear of cards, badges and lane headers, tested in `packages/renderer/src/render.test.ts`; see [`change-map/compare-light.png`](change-map/compare-light.png).
4. **Ambiguous file names** in the risk table: two files show as `invitations.ts`. Show the parent folder when names collide.
5. **No way to reach Ask or the drafts list below 1180 px**. Add a drawer or tab.
6. **Coverage minutes** are computed from additions only; the real estimate comes from the analysis (`triage.files[].reviewMinutes`, H2 #9). H4-9 hides every review-time estimate; the card counts high-risk files left.

Status (P6-1): defect 5 is fixed for the shell, the right panel and the sidebar open as drawers
below their breakpoints ([pr-panel-drawer-375-light](../../apps/web/e2e/__screenshots__/pr-panel-drawer-375-light.png)). Defect 1 is fixed for the shell (no
horizontal scroll at 375 px, `shell.e2e.spec.ts`); the risk table and change map are P6-2.
Defect 6 is fixed in the coverage card.

Status (P6-2): defect 1 is fixed for the briefing: the risk table stacks at 375 px (H4-10: the
risk chips wrap) and the change
map scrolls inside its own box (`briefing.e2e.spec.ts` "layout"). Defect 4 is fixed: the risk
table shows the parent folders a name needs to be unique (`auth/invitations.ts`,
`routes/invitations.ts`). Defect 3 belongs to the renderer (P5-1).

## Intentional differences

- **Contrast (P6-1).** Where the POC's colours fall below WCAG AA (4.5:1) for small text, the app
  keeps the palette and uses a different token: the PR number and the sidebar group labels use
  `--muted` (POC `--faint`); risk score badges keep the level's tint but the number uses `--text`
  (POC level colour on tint, 3.2–4.1:1 in light mode); the "Commented"/"Closed" status pill
  uses `--text` on `--low-bg`; "✦ AI briefing" keeps the cyan mark and sets the label in
  `--text` (POC `--ai` at 3.7:1). axe reports 0 serious issues at all widths and modes.
- **Lower-risk files collapsed (H4-9).** The POC lists every group open. The app opens only
  Critical and Important; Normal, Low and noise show their headers and counts behind one toggle
  (always shown, with no toggle, when nothing is Critical or Important). The choice is kept
  per browser.
- **Files by risk as count chips (H4-10).** The POC's risk table gives each level a sentence
  ("3 files need your attention", "… worth a careful look", "… to skim", "… don't matter") and
  lists every file. The app shows one chip per level with files (its dot, label and count) and
  only the selected level's files, the highest risk level first; Not analysed ranks above Ignore,
  as in the sidebar; levels with no files are left out. Less text to read; every file is still one click away.
- **No suggested review path (H4-11).** The POC lists a numbered path (file, why, score) between
  the change map and the memory. The app leaves it out: the files by risk and the change map
  already say where to look. The document's path still orders "Start with the riskiest file", k
  and j — [brief-1440-light](../../apps/web/e2e/__screenshots__/brief-1440-light.png),
  [brief-1024-dark](../../apps/web/e2e/__screenshots__/brief-1024-dark.png),
  [brief-375-dark](../../apps/web/e2e/__screenshots__/brief-375-dark.png).
- **Brand mark and tab icon (H4-18).** The POC's mark is a cyan-to-indigo gradient square. The
  app uses the Rocky mountain from the website, drawn in `--text` (so it follows light/dark),
  32 × 22 px; the tab icon is the same mountain (`public/favicon.svg`, its stroke follows the
  browser's colour scheme; ICO and apple-touch-icon fallbacks are a white mark on a dark tile) —
  [pr-shell-1440-light](../../apps/web/e2e/__screenshots__/pr-shell-1440-light.png),
  [pr-shell-1440-dark](../../apps/web/e2e/__screenshots__/pr-shell-1440-dark.png),
  [inbox-1440-dark](../../apps/web/e2e/__screenshots__/inbox-1440-dark.png).
- **Noise box text (P6-1).** The POC's "Lockfile + generated types … The AI found nothing
  unusual" was hard-coded; the app states what the analysis says: "n files (lines) the AI
  summarised as noise".
- **Top bar at ≤ 760 px (P6-1, P6-9).** The brand mark is hidden (its name already was in the
  POC). The Files toggle sits beside the PR, whose title has the full width (up to two lines,
  `#number` outside the clipped text) above two lines of details; the link reads "GitHub ↗"
  beside the counts ("View on" is kept for screen readers). "?", "Finish review" with its count
  and the Review panel toggle take a row of their own below, in DOM order. The light/dark toggle
  moves into the shortcuts dialog (`m` still works). The bar is about 119 px tall (the POC's
  92 px bar cut off its own Finish button, defect 1). Until P6-9 the actions shared the title's
  row, which left the title ten characters and the Finish button only its count
  ([audit D1, D2](parity-audit.md)).
- **Top bar from 761 to 1180 px (P6-9).** The "?" button drops the word "Shortcuts" (its name
  is unchanged), giving the Review panel toggle its room, so the details wrap on two lines as in
  the POC. At every width the approvals and comments wrap together and the GitHub link on its
  own, as in the POC ([audit D6](parity-audit.md)).
- **Drawer toggles (P6-1).** The top bar gains a Files toggle (≤ 760 px) and a Review panel
  toggle (≤ 1180 px), and a skip link; the POC has neither (defect 5).
- **File view (P6-3).** Line numbers use `--muted` (POC `--faint`, 2.4–2.6:1); comments and
  numbers in code use `--syn-com` / `--syn-num`, AA shades of the POC's `--tk-com` / `--tk-num`
  (3.2–4.5:1 on the diff backgrounds); the risk label, the AI-strip labels and the flag labels set
  their text in `--text` and keep the level/AI/kind colour on a dot or mark. Below 760 px the path
  takes its own line in the sticky header. Only new-side lines take a comment (as in the POC).
  "✦ Polish with AI" is left out of the composer until there is an AI endpoint for it. Invisible
  characters in code (bidi controls, zero-width, tag characters) show as visible `U+XXXX` markers. The AI notes are hidden when the
  analysis is for an older push than the diff. An added file has one line-number column (the POC
  kept an empty 44 px old-number column), so code and notes start further left (P6-9 audit A10).
- **Briefing contrast (P6-2).** As in the shell: the verdict level ("Critical risk") is set in
  `--text` and the level is carried by the box tint and a bar on its left (POC: level colour on
  tint); the risk chips (H4-10) set the label in `--muted` (`--text` when selected) and the count
  in `--text`, with the level colour on the dot; change-map lane labels and memory
  sources use `--muted` (POC `--faint`); finding badges on map cards are outlined in the severity
  colour with the count in `--text` (POC: filled circle with panel-coloured text).
- **Briefing headings (P6-2).** The card keeps the P6-1 heading "Briefing & change map" and the
  sections have headings (the POC's eyebrows), so screen readers can move between them.
- **Change map legend (P6-2).** Adds "Changed" (modified cards), which the POC's map coloured but
  its legend left out.
- **Change map click-through (P5-3).** Beyond the POC (cards only, mouse only): finding badges
  open their worst finding in the diff, focused on its line; cards and badges are focusable
  buttons (Tab, Enter, Space) with the app's focus ring; the hint reads "click a card to open its
  file, a badge to open its finding". From 760 px the map shrinks to the column like the POC's
  diagram, but not below 640 px; on phones it keeps its size and scrolls in its box.
- **Accessibility budget (P6-8).** On the change map, digits on a high or medium badge use
  `--text` in light mode (`--on-high`/`--on-med`; white on orange/amber was 3.6:1), a clickable
  badge takes clicks from an invisible 32-unit square around it (24 CSS px when the map is drawn
  at 3/4 size, WCAG 2.2 2.5.8; it overlaps the card's top-right corner, where a click now opens
  the finding, in the same file) and its keyboard focus is a thick `--you` ring on the badge
  itself
  ([map-focus-badge-1440-light](../../apps/web/e2e/__screenshots__/map-focus-badge-1440-light.png),
  [map-focus-badge-375-dark](../../apps/web/e2e/__screenshots__/map-focus-badge-375-dark.png)); when
  the map scrolls sideways (phones) a line under it says so
  ([brief-375-light](../../apps/web/e2e/__screenshots__/brief-375-light.png)). On touch screens
  without hover, buttons drop their key hints (the "?" shortcuts button keeps its own). The
  sidebar's coverage bar is not announced as a progressbar when there are no high-risk files.
  In light mode the "Changes requested" status pill sets its text in `--text` on `--crit-bg`
  (POC `--crit`, 3.9:1), like "Commented"; dark mode keeps `--crit`.
- **Rocky's own briefing (P6-2, not in the POC).** When `provenance.briefingUnavailable` is set,
  the eyebrow reads "Briefing by Rocky" without the AI mark and a note says why.
- **Drafts (P6-4).** As elsewhere, small AI and severity text is set in `--text`/`--muted` with
  the colour on a mark, dot or border: the severity pill (dot + tint), "from AI draft", the
  "✦ draft" badge (gone from the panel since H4-14, which shows the severity pill there), the dismissal note (on `--ai-bg`), and the tally numbers (a coloured top border
  per box instead of coloured numbers). The draft's outer border is `--border` (the POC mixed in
  `--ai`; colour functions are not allowed outside the tokens) with the cyan left bar kept, and
  "Send to agent" has a cyan border. The dismissal note says Rocky keeps the reason rather than "will remember", since
  project memory (P8) does not learn yet. Drafts are hidden on a diff newer than the analysis,
  like the AI flags. While a draft is edited, Save /
  Cancel and the "⌘↵ / Ctrl+Enter to save · Esc to cancel" hint sit under the textarea, above the
  suggested change (POC: below it), next to the field they act on (P6-9 audit A12). Pending
  comments are signed with the reviewer's login (P6-9).
- **Ask (P9-2, ADR 0041).** The right panel's tabs are an ARIA tablist ("Review · n", "✦ Ask"),
  both panes stay mounted so a draft or a chat is not lost on switching. The POC's Ask answered
  from canned text; the app shows every state the server can be in: checking the index, not
  indexed, indexing, off, a failed check (Try again), "Reading the code…", an answer, "no good
  answer" (with the model's note) and errors (Try again). Citations open the file at the
  indexed commit on GitHub in a new tab (the POC's links went nowhere): the index is of the
  default branch, so the cited lines are often not in the PR's diff. `/` attaches the selected
  code as a chip the reviewer can remove (the POC pasted it into the box, where it ate the
  question's 2 000 characters). The suggested questions are generic (the POC's named F1). The
  answer bubble is `--panel-2` with the cyan left bar of AI text (POC: a plain panel).
- **Finish review (P6-6).** The list shows each comment's Markdown source in a box (the POC
  listed titles only): what GitHub receives is what the person reads. Approve is suggested but
  not pre-selected (the POC pre-selected it). The count pill on the button is `--on-you` on
  `--you` (the POC used a 22% `color-mix`, not allowed outside the tokens). Submit is disabled
  until a verdict is picked and, for Comment / Request changes, until there is something to
  post or a summary. The modal shows the server's answers (stale, new commits, GitHub's refusal,
  a lost answer) which the POC's mock never had. P6-9: the list and its caption scroll in one
  box of their own so the verdict and Submit are in view when the modal opens (every comment
  stays whole); the head is sticky like the footer; the summary box is two rows (POC three);
  on phones only the suggested verdict keeps its one-line reason, and the coverage warning lists
  its files behind "Show files" (the verdict and Submit are in view on open down to 375 × 667).
- **Shortcuts (P6-5).** "? Shortcuts" stays in the top bar below 760 px as "?" (the POC hid it),
  so the dialog and its switch can be reached at every width. The dialog adds a "Single-key
  shortcuts" switch (WCAG 2.1.4) and a "?" row. The
  `.kbd-on` hint border is `currentColor` (the POC used a 40% `color-mix`, not allowed outside the
  tokens). The strip lists "/ ask" (P9-2) and ends with "? all shortcuts". j from
  the first file goes back to the briefing (the POC stayed on the file). Shortcuts are off while
  a drawer or dialog is open.
- **Change tree (H4-12, not in the POC).** Built from the approved mockup's option A with the
  app's tokens and the shortcuts dialog's modal frame, not the mockup's CSS. Differences from the
  mockup: the modal title is "Change tree"; lines changed show deletions too ("+34 −3"); the lede
  leaves out the mockup's "all in billing/src and docs/adr"; the riskiest top folder (worst level,
  then files to read, then size) starts open together with its sub-folders that hold files to
  read, so those files are named without another click (the mockup opened only the top folder);
  not analysed files get a group of their own; below 520 px the lines column is dropped, as in
  the mockup, and the counts take two lines ("N files ·" / "K to read") so short folder names stay whole. The "new" tag is the app's
  neutral pill (the mockup's green text on a pale fill is below 4.5:1 at that size), and the
  Ignored and Not analysed lines have an empty bar slot (their files are one level) so the counts
  line up. The modal is pinned near the top rather than centred, so it does not jump when a
  folder opens or closes, and has a 1px border. The header counts folders over every changed
  file, as it counts files. The focus ring goes round the whole
  row, and the title stays in view while the list scrolls. The tree is nested lists with
  disclosure buttons, not `role="tree"`.
