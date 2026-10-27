# POC parity checklist

Every feature, state, interaction and shortcut in `design-poc/index.html`, mapped to the task
that builds it in the real app (task P0-9). Screenshots of each state: [`poc/README.md`](poc/README.md).

Phase 6 PRs tick items here (`[x]` + link to the screenshot that proves it). Phase 6 is done
when every item is `[x]` or has a written reason in **Intentional differences**.

## Top bar

- [ ] P6-1 · Brand mark + "Rocky Reviews"
- [ ] P6-1 · PR title + `#number`
- [ ] P6-1 · Status pill: Open / Approved / Changes requested / Commented (changes after submit)
- [ ] P6-1 · Repo name, "@author wants to merge `head` → `base`"
- [ ] P6-1 · +additions / −deletions · file count · "updated N ago"
- [ ] P6-1 · Existing approvals count with approvers on hover (from GitHub)
- [ ] P6-1 · Existing comments count (from GitHub)
- [ ] P6-1 · "View on GitHub ↗" link (opens the PR)
- [ ] P6-1 · Light/dark toggle (☾/☀), remembered per browser, defaults to system
- [ ] P6-5 · "? Shortcuts" button
- [ ] P6-6 · "Finish review" primary button with pending-comment count

## Sidebar (triage)

- [ ] P6-1 · Coverage card: "Critical + Important reviewed n/m", progress bar, minutes of high-risk code left, "all reviewed ✓" state
- [ ] P6-2 · "Briefing & change map" entry
- [ ] P6-1 · Files grouped by risk level (Critical, Important, Normal, Low) with counts
- [ ] P6-1 · Per file: viewed checkbox, path (truncated from the left), severity dots per finding (faded when decided), risk score badge
- [ ] P6-1 · Viewed files struck through
- [ ] P6-1 · Noise group: collapsed summary box with "Trust & mark viewed" and "Show"
- [ ] P6-1 · Noise files listed once shown or trusted

## Briefing (P6-2)

- [ ] "✦ AI briefing · est. ~N min review" header
- [ ] Summary paragraph (intent of the PR)
- [ ] Risk verdict box (level + why)
- [ ] Risk table: Critical "need your attention", Important "worth a careful look", Normal "to skim", Ignore "don't matter" (low + noise), with clickable file names
- [ ] Change map (P5-1/P5-3): lanes, cards coloured by delta, hero edges animated, edge labels, finding-count badges by worst severity, click card → file, legend
- [ ] Change map unavailable (H2 #2, not in the POC): when the document has no `graph`, the rest of the briefing still renders and the map area shows "Change map unavailable", the reason from `provenance.graphUnavailable` (none when the field is absent) and a Retry button
- [ ] Suggested review path: numbered, file + why + score, clickable
- [ ] "Project memory applied" list with source PR
- [ ] "AI checked, looks fine" list
- [ ] "Start with the riskiest file (k)" button

## File view (P6-3)

- [ ] Sticky header: risk label + score, path, +/−, "Mark viewed (v)" / "✓ Viewed"
- [ ] AI strip: "What changed", "Why <level>", "Drafts: n findings"
- [ ] Hunk headers
- [ ] Old/new line numbers, +/− signs, add/del backgrounds
- [ ] Syntax highlighting (keywords, strings, comments, numbers)
- [ ] Hot-line marker on the left edge coloured by severity / flag kind
- [ ] AI flags under lines: "✦ Look here", "✦ Your call" (question for the reviewer), "✓ Checked"
- [ ] Click a new-line number → compose your own comment (Add / Cancel / "✦ Polish with AI", ⌘↵ to add)
- [ ] Your own pending comments inline with Delete
- [ ] Footer: "Mark viewed & next →" / "Next file →"
- [ ] Noise file view: AI summary + "Show raw diff"

## AI drafts (P6-4)

- [ ] Draft card: "✦ AI draft", severity pill, confidence %, "Only you can see this until you accept it"
- [ ] Title, body (inline code), suggested-change mini diff (with optional context line)
- [ ] Project-memory evidence line with source
- [ ] Accept (a) → becomes "@you · Pending · from AI draft" with Undo
- [ ] Edit (e) → textarea → "Save as my comment" → "edited from AI draft"
- [ ] Dismiss (d) → reason chips (Not a real issue / Intentional / Not worth it here / Already handled elsewhere / Cancel) → collapsed "dismissed (reason)" with Undo
- [ ] "Send to agent ↗" copies a fix prompt (toast)
- [ ] Focus ring on the focused draft (n/p)

## Right panel

- [ ] P6-4 · Review tab with count of undecided drafts
- [ ] P6-4 · Tally: AI drafts to decide / Your comments / Dismissed
- [ ] P6-4 · "To decide · by severity" list, then "Decided", item → jumps to the draft
- [ ] P6-4 · "Rocky will remember n dismissals" note (P8-2)
- [ ] P6-4 · "Your own comments" list → jumps to the line
- [ ] P9-2 · Ask tab: empty-state hint, suggested questions, chat bubbles, "Reading the code…" typing state, answers with clickable `file:line` citations, Enter to send
- [ ] P6-5 · Shortcut strip at the bottom of the Review tab

## Finish review modal (P6-6)

- [ ] Warning: high-risk files not marked viewed (names)
- [ ] Success state: all Critical/Important reviewed
- [ ] Warning: n AI drafts undecided, won't be posted
- [ ] Exact list "Will be posted to GitHub as @you (n)"
- [ ] Overall comment textarea + "✦ Draft a summary from my comments"
- [ ] Verdict: Comment / Approve / Request changes; Request changes pre-selected (with reason) when a critical/high finding was accepted
- [ ] Keep reviewing / Submit review → toast + status pill updates

## Keyboard (P6-5)

- [ ] k next file, j previous file (risk order, noise included)
- [ ] n / p next / previous draft (undecided first)
- [ ] a accept, e edit, d dismiss (focused draft in the current file)
- [ ] v toggle viewed
- [ ] / open Ask, pre-filled with selected code
- [ ] b back to briefing
- [ ] m toggle light/dark
- [ ] ? shortcuts dialog
- [ ] ⌘↵ open Finish review; Esc closes dialogs / cancels edit, dismiss, compose
- [ ] Shortcuts ignored while typing in a text field

## Feedback

- [ ] P6-4 · Toasts: accepted ("not posted yet"), agent prompt copied, noise trusted, "✦ Polished" after Polish with AI, review submitted

## Responsive

- [ ] P6-1 · < 1180 px: right panel hidden (the real app must offer it another way, see defects)
- [ ] P6-1 · < 760 px: sidebar hidden, secondary top-bar items hidden

## Known POC defects (do NOT copy)

Found while capturing the P0-8 screenshots.

1. **375 px overflows horizontally**: briefing text, risk table and the Finish button are cut off. The real app must have no horizontal page scroll at 375 px (risk table stacks, change map scrolls inside its own box).
2. **Right-panel "draft" badge is clipped** ("dra", "draf") when titles wrap. Reserve space or wrap the badge.
3. **Change-map edge labels overlap cards** ("POST /accept", "read token", "grant role"). P5-1 must place labels in free space. Done in the renderer (P5-1): labels are pills placed clear of cards, badges and lane headers, tested in `packages/renderer/src/render.test.ts`; see [`change-map/compare-light.png`](change-map/compare-light.png).
4. **Ambiguous file names** in the risk table: two files show as `invitations.ts`. Show the parent folder when names collide.
5. **No way to reach Ask or the drafts list below 1180 px**. Add a drawer or tab.
6. **Coverage minutes** are computed from additions only; the real estimate comes from the analysis (`triage.files[].reviewMinutes`, H2 #9).

## Intentional differences

_None yet._
