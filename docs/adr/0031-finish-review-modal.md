# ADR 0031: Finish review modal

- **Status:** Accepted
- **Date:** 2026-10-30
- **Task:** P6-6
- **Revised:** review round 1 (B1, S1–S4, UI-verifier): an answer that cannot say what happened
  is "may or may not have been posted" and the retry reuses the idempotency key; full paths;
  a list over GitHub's limits is shown and blocks Submit; content-carried drafts from a re-run
  (#39) are read-only; `refresh` keeps the page's state; invisible characters are shown as
  markers; the phone-width button, disabled styles, sticky footer. P6-9 (parity audit D2–D5):
  the list scrolls in its own box so the verdict and Submit are in view when the modal opens;
  sticky head; the Finish button keeps its label on phones; the login keeps its case.
- **Builds on:** [ADR 0026](0026-posting-as-the-user.md) (P3-5: the preview/submit API, the
  digest, idempotency, outcomes), [ADR 0027](0027-review-drafts.md) (P6-4: drafts and pending
  comments), [ADR 0030](0030-keyboard-shortcuts.md) (P6-5: ⌘/Ctrl+Enter, modals and shortcuts),
  [ADR 0019](0019-web-app-shell.md) (shell, status pill)
- **Amends:** ADR 0026 residual risk 1 (posted items are read-only in the page), ADR 0030 §6
  (the Finish entry point is filled), ADR 0027 §3 (the drafts answer says what is posted)

## Context

The person has accepted, edited and dismissed AI drafts and written comments. Finishing the
review means: look once more at exactly what will leave under their name, add a summary and a
verdict, and click. The POC's modal (`openFinish`) shows the coverage warning (high-risk files
not marked viewed), the undecided-drafts warning, the list "Will be posted to GitHub as @you",
a summary box with "Draft a summary from my comments", the three verdicts with Request changes
pre-selected when a critical or high finding was accepted, and Keep reviewing / Submit review.

P3-5 built the posting service around one contract: the server builds the list, hashes it, and
refuses to post a list the client did not see. The modal is the client side of that contract.
The criterion is "what's shown == what's posted; double-submit impossible". Two things make it
risky: the modal is where model text turns into a comment under a person's name (a mention, a
link, an image or a suggestion block in a draft is posted as the person's), and the click is the
only side effect in the whole product that a human cannot take back.

## Decision

### 1. The list is the server's, shown as source

- The modal reads `GET /api/pull-requests/:id/review` (ADR 0026 §6) every time it opens and
  whenever the server says the list changed. Nothing in the page composes the list: the
  drafts provider's state gives the counts (the Finish button's count, the undecided warning,
  the suggestion), the server's answer gives the items.
- Each item is shown with its full location (`path:line`) and kind, and its `body` **as
  Markdown source** in a `<pre>`, as React text inside a `<bdi>`. No Markdown
  rendering: a rendering could hide a link's target, an image, a mention or HTML, and GitHub's
  rendering is not ours to imitate. Characters a reader cannot see (bidi controls, zero-width
  and joiner characters, C0/C1 controls, tag characters) are shown as `U+…` markers with a
  warning line, since `<bdi>` isolates the body from its surroundings but not the text inside
  it from an override. The caption says so. Nothing is cut or collapsed: every comment is
  shown whole. P6-9: the list (with the caption) scrolls in **one box of its own**, a single
  focusable, named region ("Comments to post"), capped in height (`.post-scroll`:
  `90dvh − 660px` from 64 to 360 px; `100dvh − 720px` on phones) so the warnings, the summary,
  the verdict with its suggestion and the footer are in view when the modal opens, at
  1440 × 900 with one or two comments and at 375 × 812 (`finish.e2e.spec.ts` "the modal
  fits"). The person scrolls the box to read the rest; nothing in it is hidden or shortened.
  (Before P6-9 each body scrolled in its own box and the list pushed the verdict below the
  fold.) A list GitHub would refuse (over 100 comments, a comment over 65,536 characters) is
  parsed with wide bounds and shown, and Submit is off with the reason.
- The click sends the preview's `contentSha256` and `headSha`, the verdict, the summary, and
  an idempotency key, through `POST …/review` with the session's CSRF token
  (`data/posting-http-source.ts`). Answers are parsed in `data/posting-data.ts` (zod): fixed
  codes only. An answer is **definite** only when it carries the server's code (`posted`, a
  409 refusal, `invalid_request`, `post_failed`, `not_found`, `posting_unavailable`, 401); a
  request that did not complete, a status without a code, or a 200 that does not say `posted`
  is **unknown**: the review may exist. The key belongs to the list it was made for: after an
  unknown answer the next click on the same list (same digest) reuses it, so the server answers
  that attempt (`repeated`) and never posts twice; after a definite answer, or once the list
  changed, the next click is a new one with a fresh key (review round 1, B1). When the session's
  CSRF token cannot be read, nothing is sent (`not_sent`).
- The shell's data carries `pullRequestId` (the fixture source gives a stable one, like the
  analysis id); without one the modal says posting is not available.

### 2. The click posts at most once

- `Submit review` is inert for `ARM_MS` (400 ms) after the modal opens (a double-click on the
  opener), `disabled` while the request runs (the label reads "Submitting…"), and a ref
  refuses a second call in the same frame. While the request runs, nothing closes the modal:
  Escape, Keep reviewing and the scrim are inert, so the answer is always seen. After a
  success the ref stays set: the shell closes the modal, and nothing from it can post again.
- The server's guarantees stand behind it (ADR 0026 §3): a repeated key answers the same, one
  attempt in flight per (PR, member), items bound at begin. A click that reaches the server
  twice (a retried request) is still one review.

### 3. Suggestions are suggestions

- **Verdict.** `finish-model.ts` `suggestVerdict`: Request changes when a critical or high
  finding was accepted and is still to post (the POC's rule), pre-selected; Comment when there
  is something to post and nothing serious, pre-selected; Approve only when every high-risk
  file was viewed, every draft decided and nothing is to post, and **never pre-selected**: an
  approval is picked by the person (the POC pre-selected it; deviation by design). Otherwise
  nothing is selected. The suggested option says "Suggested" and why. Submit is off until a
  verdict is selected, and off for a Comment or Request changes review with nothing to post and
  an empty summary (the server would answer `empty_review`; the modal says what to do).
- **Summary.** "Draft a summary from my comments" composes a numbered list from the items to
  post (a draft's title, an own comment's first line, each with `file:line`); no model is
  called and no network. The draft lands in the textarea, focused, with a note that it is a
  suggestion; the person edits, clears or replaces it. The button is off without items. A real
  model-written summary needs the Ask endpoint (P9-2); the button's wording is the POC's.
- **Warnings.** High-risk files not marked viewed (by file name, full path in a tooltip) or
  the success line; the count of undecided drafts with "They won't be posted. Only what you
  accepted goes out." Warnings never block the click: the person decides.

### 4. Every answer, honestly

| Answer (ADR 0026 §6)                                                                    | The modal                                                                                                                                                         |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `posted`                                                                                | closes; toast "Review submitted to GitHub as @login."; the status pill shows the verdict; the drafts are loaded again                                             |
| `stale`, `head_moved`                                                                   | "Nothing was posted. The list was loaded again": the list is fetched again, the person checks it and clicks again (fresh key)                                     |
| `in_progress`                                                                           | says an earlier attempt is still being confirmed, nothing was posted, try again in a minute; the list shows the attempt                                           |
| `post_failed` (+ reason)                                                                | "Nothing was posted." with GitHub's reason in words (`rejected`, `forbidden`, `token_rejected`, `not_found`); items stay listed                                   |
| `post_unknown`                                                                          | "the review may or may not have been posted. Check the pull request on GitHub" with a link; the list shows the attempt in flight; the carried items are read-only |
| `no_revision`, `token_unavailable`, `key_reused`, `invalid`, 404, 503, 401, a coded 4xx | a fixed sentence each; nothing posted; no toast                                                                                                                   |
| unknown (the request did not complete, an uncoded status, an unparseable 200)           | "may or may not have been posted", link to GitHub, the list and the drafts are read again; the next click on the same list reuses the key                         |
| `not_sent` (no CSRF token)                                                              | "nothing was sent"; nothing posted                                                                                                                                |

The notice is a focused `role="alert"` inside the modal. The list is loaded again after every
answer but `invalid`. A success is the only outcome that closes the modal.

### 5. Posted items are read-only

- `GET /api/analyses/:id/review` (ADR 0027 §3) now says, per draft and comment, whether a
  review attempt carries it: `posted: "posting" | "posted" | null` (`packages/db`
  `listReviewDrafts`, from the one `carried` definition P3-5's plan and `isCarried` use,
  `carriedStatusSql`; a `failed` attempt releases its items). A draft whose **content** this
  member already posted on the revision from another analysis (a re-run renumbers findings;
  #39 matches by content and refuses to accept it again) is reported `posted` too, even when
  undecided: the page shows one read-only line, leaves it out of "still undecided", n/p and
  the suggestion, instead of offering a decision the server would refuse.
- The page: an accepted draft or own comment with `posted` shows "Posted" (or "Posting…"
  while the attempt is confirmed) instead of "Pending", has no Undo or Delete, and the review
  provider sends no action for it (keys included: they press the card's buttons, which are
  gone). The panel's badge reads "posted". The Finish count leaves them out.
- The server's refusal `already_posted` (409, #39) updates that one draft from the refusal's
  `draft` (a comment's DELETE refusal marks that comment) and says "This was already posted to
  GitHub, so it can no longer be changed."; `comment_too_long` (400) puts the draft back and
  says the comment was not saved. The e2e mock answers both.
- After a successful click, and after an unknown answer, the provider **refreshes**: it reads
  the review again and merges it in without resetting the page (an edit in progress, the
  focused draft and decisions still being saved are kept), so the posted items turn read-only
  at once. The shell also reads the preview once on load, so the status pill shows the latest
  posted attempt's verdict after a reload (GitHub is the truth; the mirror's own `myReview`
  replaces this when the server serves the shell data).

### 6. A modal like the others

The shell renders it like the shortcuts dialog: the rest of the page is `inert`, Tab is trapped
(`trapTab`), focus starts on Close, Escape and a click outside close it (never while sending),
focus returns to the opener (the Finish button) or to the main column. Single-key shortcuts are
off while it is open (`ShortcutKeys` `active`); ⌘/Ctrl+Enter opens it (ADR 0030 §6 filled), and
the top bar's "Finish review" button carries the pending count and `aria-keyshortcuts`. P6-9:
the head (title and Close) is sticky like the footer, so Close stays in view on a phone; the
footer's status line shares the buttons' row when it fits; on phones the options other than
the suggested one show their names only (the suggested one keeps its reason), and the Finish
button keeps its visible label at every width.

## Threat model

**Assets:** what is published under the person's name (comments, summary, verdict); the pull
request's review state on GitHub; the person's trust that the list is the truth; the server's
idempotency contract. **Attackers:** the PR author through model text in drafts (mentions,
links, images, HTML, suggestion fences, bidi controls), the LLM (steering the verdict or the
summary), another tab, a double click or key repeat, a lost answer, a stale page, the page's
own bugs. Tenant and credential threats are the server's (ADR 0026 P1–P15) and unchanged.

| #   | What can go wrong                                                               | Prevention                                                                                                                                                                                                                                                         | Test                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | The modal shows something other than what the server posts                      | The list is `GET …/review`'s items, shown field by field; the click echoes the digest and head; the server rebuilds and refuses `stale`                                                                                                                            | `finish.e2e.spec.ts` "the modal lists exactly the server's plan… and the click posts exactly it" (the shown list equals the mock's plan, the posted review equals the shown list); server: `post-review.db.test.ts` "posts exactly the previewed items…", "refuses a list that changed…" |
| M2  | A rendering hides part of a comment (a link's target, an image, a mention)      | Markdown source as text in `<pre><bdi>`; no Markdown renderer; caption says so                                                                                                                                                                                     | e2e: the hostile body's mention, URL, `<img>`, link and fence are visible as text and the list has no `a`, `img` or `script`; `posting-data.test.ts` keeps bodies byte for byte                                                                                                          |
| M3  | Two reviews from one intent (double click, Enter twice, retry)                  | Arming, `disabled` while sending, ref guard, a fresh uuid per click, the modal cannot close while sending; server idempotency and lock                                                                                                                             | e2e "clicks, Enter and a double-click while the request runs post exactly once", "Submit is inert right after the modal opens", "every click carries a fresh idempotency key…"; keyboard e2e presses Enter twice                                                                         |
| M4  | Something posts without the person's click                                      | Only `submit()` calls the source, only from the Submit button; opening, warnings, suggestions and drafting do no request but `GET`                                                                                                                                 | e2e: opening, Escape, Keep reviewing, a click outside, drafting a summary and picking a verdict leave `POST` at zero                                                                                                                                                                     |
| M5  | The suggestion or the drafted summary decides for the person                    | Approve is never pre-selected; the suggested option is labelled with its reason; the summary is a suggestion the person edits or clears; nothing in it comes from a model call                                                                                     | `finish-model.test.ts` (rules), e2e "Approve is suggested but never pre-selected", "the drafted summary… can be edited or cleared"                                                                                                                                                       |
| M6  | A list that changed (another tab, a push) is posted                             | The server refuses `stale` / `head_moved`; the modal says nothing was posted and reloads the list                                                                                                                                                                  | e2e "a list that changed after the preview is refused and loaded again; new commits too"                                                                                                                                                                                                 |
| M7  | A lost answer is reported as success or as failure, or a retry posts twice      | Only coded answers are definite; unknown ones read "may or may not have been posted" with a GitHub link; the retry on the same list reuses the key, so the server answers the earlier attempt; the key is dropped once the list changed or the answer was definite | e2e "no usable answer… the retry reuses the key and never double-posts (B1)", "the same list after a dropped request… the same key posts once", "no answer from GitHub (post_unknown)…"; `posting-data.test.ts` (uncoded statuses and a 200 without `posted` are unknown)                |
| M8  | A posted comment is edited, undone or deleted as if pending                     | `posted` from the server; no Undo/Delete; the provider refuses actions on posted items; `already_posted` reloads and explains                                                                                                                                      | `drafts.test.ts` (db) "…carried by a posting or posted attempt say so…", `routes.db.test.ts`, `DraftCard.test.tsx`, `FileView.test.tsx`, e2e "a draft posted from another tab…" and the first test's read-only checks                                                                    |
| M9  | Free text from an answer is shown or matched                                    | Codes must match `^[a-z][a-z0-9_]{0,63}$`; unknown codes are generic errors; sizes bounded                                                                                                                                                                         | `posting-data.test.ts` "refuses malformed answers…", "409 refusals by fixed code…"                                                                                                                                                                                                       |
| M10 | Bidi controls or invisible characters make a body read one way and post another | React text; `<bdi>` around the login, locations and bodies; every invisible character shown as a `U+…` marker with a warning line; no `dangerouslySetInnerHTML`                                                                                                    | `finish-model.test.ts` "reveals the invisible characters…", e2e "invisible characters… show as markers and are named", `FinishReview.test.tsx` (login in `<bdi>`)                                                                                                                        |
| M11 | The modal is unreachable or traps the keyboard                                  | Focus on Close, Tab trapped, Escape closes, focus returns; axe                                                                                                                                                                                                     | keyboard e2e (the full review through Submit), e2e "the modal" and axe at three widths × two modes                                                                                                                                                                                       |
| M12 | Secrets or content in logs                                                      | The page logs nothing; errors carry a status only; the server's logs are unchanged                                                                                                                                                                                 | `posting-data.test.ts` (error messages name no value)                                                                                                                                                                                                                                    |

## Consequences

- New: `apps/web/src/finish/` (`FinishReview.tsx`, `finish-model.ts`, `finish.css`, `testing.ts`),
  `apps/web/src/data/posting-data.ts`, `posting-http-source.ts`; the e2e mock answers the posting
  API (`apps/web/e2e/review-api.ts`); suites `finish.e2e.spec.ts`, `finish.visual.spec.ts`.
- `ShellData.pullRequestId`; `DraftRecord.posted`, `OwnComment.posted`; `ReviewSource.decide`
  may answer `posted`, `deleteComment` answers `deleted | posted`; `ReviewContextValue.reload`.
- P3-5's drafts answer gains `posted` (`packages/db/src/drafts.ts`, `apps/server/src/reviews/routes.ts`);
  no route, policy, migration or table changes.
- The status pill after a post is page state plus the server's latest posted attempt on load;
  GitHub's own view (`myReview` from the mirror) is still the long-term source.
- The summary draft is template text, not a model's; the POC's "✦" wording is kept because the
  items it lists are model text. Revisit with Ask (P9-2).

## Residual risks

- Rocky's own view of "posted" is the attempt table: a review the person submitted on GitHub
  by hand is not known here (the drafts stay pending; posting them again is their call).
- A re-run analysis of the same head has new draft rows: decisions and the `posted` flag belong
  to the analysis the page shows (ADR 0027 §2 carry-over follow-up); P3-5's boundary fix keeps
  such a finding from being offered again on the server.
- `ARM_MS` is a heuristic against a double-click on the opener; the server's idempotency is the
  control. While arming, the footer says "One moment…".
- A content-carried draft is reported `posted` without the attempt's status (the match is by
  content, across analyses); in the first minute after a lost answer it may still be in flight.
- The key is reused only for the same digest. If an unknown answer did post, the reloaded list
  differs (the items are carried), so the retry is a new click: it is answered about the new,
  smaller list, never about the lost one; the modal shows the posted attempt above the list.
- The POC's mobile breakpoints were not designed for this modal. Since P6-9 it fits 375 × 812
  with the fixture's warnings; longer warnings (many unviewed files, an in-flight attempt, an
  error notice) can still push the verdict down, and the modal then scrolls with its head and
  footer pinned. The list box can be as small as 64 px on short screens: whole, but scrolled.
