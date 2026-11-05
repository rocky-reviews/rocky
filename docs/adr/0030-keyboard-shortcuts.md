# ADR 0030: Keyboard shortcuts on the PR page

- **Status:** Accepted
- **Date:** 2026-10-30
- **Task:** P6-5
- **Builds on:** [ADR 0019](0019-web-app-shell.md) (shell, drawers), [ADR 0023](0023-diff-viewer.md)
  (diff keyboard path), [ADR 0027](0027-review-drafts.md) (drafts)

## Context

The POC reviews a PR from the keyboard: k/j next and previous file, n/p next and previous draft,
a/e/d accept, edit and dismiss the focused draft, v viewed, / ask, b briefing, m light/dark,
? help, ⌘↵ finish, Esc close. Most of these keys are single characters. WCAG 2.1.4 (Character
Key Shortcuts, level A) requires that such shortcuts can be turned off, remapped, or are only
active while a component has focus: speech-input users otherwise trigger them by dictating
words. The page also has text fields (the comment composer, the draft editor) where the same
letters must type.

## Decision

1. **One listener.** `keyboard/ShortcutKeys.tsx` registers one `keydown` listener on the
   document; `keyboard/keymap.ts` decides, purely, what a key means (`shortcutFor`) and where
   k/j and n/p go (`stepFile`, `stepDraft`).
2. **When a key is a shortcut.**
   - Never while focus is in a text entry: text-type `<input>`, `<textarea>`, `<select>`,
     `contenteditable` (`isTextEntry`). Checkboxes and buttons are not text entries.
   - Single-character keys fire only without Ctrl, ⌘ or Alt (Shift is part of `?`). ⌘/Ctrl+Enter
     fires only with no Alt or Shift.
   - Letters are matched lower-case when Shift is not held, so Caps Lock does not disable them;
     on a layout whose letters are not ASCII (Cyrillic, Greek…) the physical key (`event.code`
     `KeyK`) stands in, so each shortcut sits where its letter is on a US keyboard. Shift+letter
     matches nothing.
   - Not for an event a component already handled (`defaultPrevented`, e.g. the diff's arrow keys
     or a draft's Escape), not during IME composition, and on key repeat only for movement
     (k j n p).
   - Not while a modal is open (a drawer below the POC breakpoints, or the shortcuts dialog):
     the listener is detached, the rest of the page is inert.
3. **WCAG 2.1.4: a turn-off switch.** The shortcuts dialog has a "Single-key shortcuts" switch,
   on by default and remembered per browser (`localStorage` `rocky-shortcuts = off`, read and
   written in `try`, like the theme). Off removes every single-key shortcut, their `<kbd>` hints
   and `aria-keyshortcuts`; the Review panel's strip says they are off. ⌘/Ctrl+Enter has a
   modifier and stays on; the dialog stays reachable from the "? Shortcuts" button in the top bar
   at every width. Remapping was not chosen: one switch covers the criterion with far less UI.
4. **Keys act through the same paths as the mouse.** n/p do what the review panel's items do
   (`jumpToFinding`: open the file, focus the draft card), and only when those items are
   enabled: the review state is loaded (`status === "ready"`) and the diff is of the analysed
   commit (not `stale`); otherwise they do nothing. a/e/d act on the focused draft only under the
   same conditions, when it is undecided and in the file on screen, by clicking that card's own
   Accept/Edit/Dismiss button, so the card's guards (a disabled button, a save in flight) apply
   to the key as well and focus moves exactly as after a click. A card scrolled out of the
   virtualised diff is brought back first and the next press acts; a card whose button is not
   shown (it is being edited or dismissed) ignores the key. a/e/d act on the highlighted
   (focused) draft, which may not be the one scrolled into view.
   k/j select a file like the sidebar and move focus to the main column; j from the first file
   returns to the briefing; a noise file reached this way opens the sidebar's noise group.
5. **Discoverable.** `?` and the top-bar button open a modal dialog (focus on Close, Tab trapped
   with the drawers' `trapTab`, Escape or a click outside closes it, focus returns to where it
   was). Buttons that a key triggers show the key in an `aria-hidden` `<kbd>` (so their accessible
   name is unchanged) and carry `aria-keyshortcuts`, which names physical keys as ARIA requires:
   the dialog button's is `Shift+/` (US layout), not `?`. Closing the dialog returns focus to
   its opener, or to the main column when nothing had focus. If the browser cannot save the
   switch, the dialog says the choice lasts until a reload instead of "Remembered". P6-9: at
   ≤ 760 px the dialog also holds the light/dark toggle, which the top bar has no room for;
   between 761 and 1180 px the top-bar button shows "?" without the word "Shortcuts" (its name
   stays "Keyboard shortcuts"), giving the Review panel toggle its room.
6. **Entry points that later tasks fill.** `/` (Ask, P9-2) and ⌘/Ctrl+Enter (Finish review,
   P6-6) show a "not available yet" toast through `onAsk` / `onFinish` in the shell; those tasks
   replace the handlers.

## Consequences

- Keys never reach a draft's state without the card's checks: there is no second code path to
  keep in step with P6-4's guards.
- a/e/d depend on the card's `data-role` buttons (already its focus contract).
- The preference is per browser, not per account; a per-user setting can come with user settings.
- Tests: `keymap.test.ts` (unit), `keyboard.e2e.spec.ts` (the keyboard-only review, typing,
  modifiers, the switch, the dialog's focus trap, axe), `keyboard.visual.spec.ts` (screenshots).

## Amendment H4-12: `t` opens the change tree

`t` (action `tree`) opens the change tree modal, the same as the sidebar's Tree button and the
briefing's "View as tree". It follows every rule above: no modifiers, not while typing, not on
key repeat, off with the single-key switch, and nothing while a modal is open (so `t` does not
fire inside the tree itself). The help dialog lists it after `b`. While the tree is open over the
Files drawer, the drawer's own Escape and Tab handling stand down, so Escape closes only the tree.

## Amendment H4-14: i/u for drafts, a/e/d only on screen, reason keys, ↑/↓ scroll

A dogfooding round changed four things; the rules above (no modifiers, not while typing, off
with the switch, nothing behind a modal) apply to each.

- **i/u replace n/p.** `i` is the next AI draft and `u` the previous, beside j/k; `n` and `p`
  do nothing now. The help and the Review panel's strip list them as "j/k previous & next file"
  and "u/i previous & next AI draft" (previous first). They walk the drafts in the Review
  panel's order (`panelOrder`): the open file's drafts first, then the other files' in the
  sidebar's order (k/j's) starting after the open file and wrapping round, each file's drafts
  by severity; on the briefing it is severity alone. Because i/u open each draft's file, the
  order is rebuilt around every file they land in; every such order is a rotation of the same
  cycle, so i visits every undecided draft once before coming round, and u undoes i across file
  boundaries. (A first cut ordered the other files' drafts by severity alone; walking with i
  then looped between the first few files and never reached the rest.) Once every draft is
  decided, i/u walk all of them, in the order the Decided list shows.
- **a/e/d only while the focused draft is on screen.** "On screen" is some of the card inside
  the main column, below the sticky file header (`cardOnScreen`, checked when the key is
  pressed). Off screen the keys do nothing: the earlier "bring it back, the next press acts" is
  gone, because a decision should be made on a draft the reviewer can see. The hints follow the
  same rule: the focused card watches itself with one IntersectionObserver and reports to a small
  provider of its own (`DraftOnScreenProvider`), so its a/e/d `<kbd>` hints and
  `aria-keyshortcuts`, and the strip's a/e/d items, show only while it is on screen. Other cards
  show no a/e/d hints (the keys never act on them).
- **1–4 pick a dismiss reason** (Not a real issue, Intentional, Not worth it here, Already
  handled elsewhere) while focus is among the reasons, which is where `d` and the Dismiss button
  put it. Each reason button carries its digit as an `aria-hidden` `<kbd>` and
  `aria-keyshortcuts`. The digit row or the keypad; where the digit row needs Shift (AZERTY) the
  physical key stands in. Not on key repeat. Escape still cancels. This is a second keyboard
  path besides the document listener: the reasons group's own `onKeyDown` in `DraftCard`
  (`reasonIndexFor`), like its Escape, so it only exists while focus is in the group; it follows
  the same rules (no modifiers, not while composing, off with the switch).
- **↑/↓ scroll the file.** With focus anywhere outside the main column (the page itself, the
  sidebar, the Review panel, the top bar), ↑/↓ scroll the main column by 40 px, the browser's
  own step (`arrowsScrollFile`, `scrollStepFor`). Not in a text field, and not inside a widget
  with its own arrow keys: role `tablist`, `tab`, `radiogroup`, `radio`, `menu`, `menubar`,
  `menuitem*`, `listbox`, `option`, `slider`, `spinbutton`, `tree`, `treeitem`, `grid`,
  `treegrid`, a `<select>`, or a range or radio input, checked on the focused element and its
  ancestors. Inside the main column the browser already scrolls the file, and a diff line or
  the diff list moves the active line (ADR 0023, H4-13), so the listener leaves those alone. So
  a keyboard user who picks a file in the sidebar with Enter (focus stays on the row) scrolls it
  with ↓; the sidebar no longer scrolls with the arrows (Tab moves through it and scrolls each
  row into view). A file picked in the sidebar with the mouse moves focus to the main column,
  so Space and Page Down scroll it too. "With the mouse" is a click with a count
  (`event.detail > 0`): a screen reader's synthetic click (VoiceOver's VO+Space reports a count
  of 1) counts as one and moves focus to the main column too. That is deliberate: the file that
  was just opened is where the reader goes next, and focus moving into the content it replaced
  is what k/j and the briefing's links already do. Arrows are not character keys, so the
  single-key switch does not turn them off.
