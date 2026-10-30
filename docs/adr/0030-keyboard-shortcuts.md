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
