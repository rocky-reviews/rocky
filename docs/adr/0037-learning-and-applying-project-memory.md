# ADR 0037: Learning project memory from posted reviews and applying it in review prompts

- **Status:** Accepted (defaults chosen for the user; open to veto at review); amended by §7
  (P8-2b, 2026-11-06)
- **Date:** 2026-11-05
- **Task:** P8-2; §7 P8-2b (the maintainer-approved follow-up, `docs/progress.md`)
- **Amends:** [ADR 0036](0036-project-memory-entries.md) (§4, the seams it left for P8-2; one
  addition to its repository: a learned supersede path), [ADR 0015](0015-prompt-injection-defence.md)
  (§2, a new untrusted channel; §3, a second canary; R3, "private prompt text needs its own
  canary")
- **Builds on:** [ADR 0014](0014-analysis-pipeline.md) (stages, unit reuse, validate and repair),
  [ADR 0018](0018-evals-and-quality-gate.md) (the eval suite and its gate),
  [ADR 0026](0026-posting-as-the-user.md) (posting a review), [ADR 0027](0027-review-drafts.md)
  (draft decisions and dismissal reasons)

## Context

P8-1 stores memory entries with evidence, a confidence and no names. P8-2 makes Rocky learn them
from what reviewers decide and use them in later reviews, citing what it relied on. The
acceptance criterion: an eval shows that a pattern dismissed as intentional is not raised again on
the next run.

Memory closes a loop that did not exist before: model output about PR content (a finding's title)
becomes stored text that comes back into a later prompt. Everything here is about keeping that
loop as narrow as the rest of the pipeline.

## Decision

### 1. When Rocky learns: once a review is posted

Learning runs after GitHub took the review (`finishReviewSubmission` recorded it `posted`, from
the forge's answer or from reconciliation), in a transaction of its own
(`learnFromReviewSubmission`, `packages/db/src/memory-learning.ts`, called by the server's posting
service). Not at each decision, because:

- a decision can be undone until the review is posted; learning on each click would create and
  retract entries with every change of mind;
- submitting is the reviewer's deliberate act, and GitHub then holds the review the entry came
  from (GitHub is the source of truth);
- a posted review is a natural idempotency key: posting twice on one revision teaches once.

A review that is never posted teaches nothing. Learning is best effort: it is derived data, so a
failure is logged as a fixed code and never changes the answer about the review.

What a posted review contributes: the drafts it carried (accepted as is, or edited), and the
reviewer's dismissed drafts on the same analyses (the analyses the carried drafts came from and
the revision's latest finished one).

### 2. What becomes an entry (core `learnedEntry`), conservatively

| Decision                                    | Entry                                                                      | Confidence |
| ------------------------------------------- | -------------------------------------------------------------------------- | ---------: |
| Dismissed as `intentional`                  | `dismissal`, reason `intentional`                                          |         80 |
| Dismissed as `not_an_issue`                 | `dismissal`, reason `not_an_issue`                                         |         70 |
| Dismissed as `handled_elsewhere`            | `dismissal`, reason `handled_elsewhere`                                    |         70 |
| Dismissed as `not_worth_it`                 | nothing: a call about one PR's priorities, not a pattern of the repository |            |
| Any dismissal of a **critical** finding     | nothing: see threat M3                                                     |            |
| Accepted and posted, edited by the reviewer | `convention`                                                               |         65 |
| Accepted and posted                         | `convention`                                                               |         60 |

- Never a `decision`: an accept carries no decision text. Decisions are what people write (P8-3).
- **Text:** deterministic, from the finding's title and the decision only: `Dismissed as
intentional: <title>`, `Accepted in review: <title>`. Never the finding's body, never the
  reviewer's edited text (free text that may name people), never a model call (nothing to
  justify one: the title already names the issue, and a model would add another injection
  surface). The title is collapsed to one line without a trailing period; a title that carries a
  canary (squashed: spacing, case, digits, look-alikes) or a run of Rocky's prompt text is
  refused; the store then scrubs it (`createMemoryEntry` with `origin: "learned"`, the PR author
  and the reviewer as `people`, every member login added by the store) and applies P8-1's rules.
  The mirror stores no commenters or requested reviewers, so there are no other logins to pass.
- **Evidence:** the finding's path and line range, the analysed head sha (from the document's
  provenance) and the pull request number (from the mirror).
- **At most 25 entries per review** (`MAX_LEARNED_PER_REVIEW`), dismissals first: they are
  what a later review acts on, so a review with many accepts cannot crowd them out.
- **Not from the author's own pull request.** When the reviewer's login is the PR author's
  (case-insensitive), the review teaches no dismissal: an author must not be able to switch a
  finding off for the whole repository by dismissing it on their own PR. Their accepts still
  teach conventions (which can only ask for findings).
- **What a dismissal covers.** A learned dismissal records the dismissed finding's severity
  (`memory_entries.severity`, migration 0018): it covers findings up to that severity and never
  a critical one (§4). Every learned entry records the reviewer's role (`learner_role`).

### 3. Duplicates: repeat, corroborate, supersede

The whole run holds the repository's memory lock (`lockRepoMemory`, the transaction-scoped
advisory lock `createMemoryEntry` already takes), so two learners at once (a post and its
reconcile, two reviewers of one repository) never both find "no repeat" and store the same entry
twice. For each candidate, in order:

1. **Repeat:** an entry already learned from the same evidence (kind, reason, path, sha, lines,
   PR) means nothing is written.
2. **Corroborate:** a current learned entry on the same path with the same kind and subject (the
   text after its fixed prefix, case and spacing folded), learned from **another** pull request,
   raises the new entry's confidence by 10, up to 95. One PR never corroborates itself (a
   re-push of the same PR is the same evidence again).
3. **Store** the new entry.
4. **Supersede** every current learned entry on the same path with the same subject, of any
   kind, by the new one: the newest human decision about a pattern wins (an accept after a
   dismissal replaces it, and the reverse), and the old entry stays as history. **Except** an
   entry taught by a reviewer with a higher role (owner > admin > member; an entry without a
   recorded role ranks as member): a member's later decision does not overturn an admin's.

Superseding rather than touching: `last_used_at` means "a review cited it" and is P8-4's decay
input; using it for "learned again" would blur that. Superseding keeps one current entry per
pattern and path, with the newest evidence, and keeps the history P8-3 can show.

**Learned supersede path (addition to ADR 0036's repository).** P8-1's fix round made
`supersedeMemoryEntry` require `memory.edit` (admin). A reviewer is usually a member, so learning
could not replace its own older entries. `supersedeMemoryEntry(…, { origin: "learned" })` mirrors
`createMemoryEntry`'s origin: it needs an active member, not `memory.edit`, and both rows must be
learned entries (`not_permitted` otherwise). Learning never replaces what a person wrote.

### 4. Applying memory in the review (`packages/core/src/analysis/memory.ts`)

- **Loading:** the worker reads the analysed repository's current entries
  (`loadAnalysisMemory`, for `target.repoId`) in the analysis's tenant transaction and passes
  them as `AnalysisRequest.memory`. Four groups are bounded apart, newest first in each:
  member-written entries (100), learned dismissals (100), conventions and decisions taught by
  an owner or admin (50, P8-2b fix round 2) and other learned entries (50), 300 in all
  (`MAX_ANALYSIS_MEMORY`). A burst of learned entries cannot push out what people wrote, newer
  conventions cannot push out the dismissals, and a member's run of accepts cannot push out an
  owner's older convention (which blocks the critical path, §7).
- **Re-checked before use** (`usableMemory`): uuid id, known kind and origin, reason paired with
  kind, a severity only on dismissals, a repository path, confidence 0..100, text and source that pass the document's `MemoryRef` rules,
  and neither a canary nor a run of prompt text in text, path or source. A refused entry is
  dropped and counted (`memoryDropped`). This keeps a stored entry from failing every later
  analysis at the final leak check.
- **Relevance rule** (`selectMemory`), per reviewed file, at most 12 entries. **Only entries on
  the file's own top-level directory or closer are offered** (path relevance ≥ 1: 3 the same
  file, 2 the same directory, 1 the same top-level directory; root-level files share one
  directory). A dismissal applies near where reviewers took it, and an entry elsewhere would cost
  tokens and, through the unit key, re-reviews of files it says nothing about. When more than 12
  qualify: path relevance, then kind (dismissals, decisions, conventions), then member-written
  before learned, then confidence, then id. The chosen entries then get their handles in id
  order, so the prompt and the unit key depend only on which entries were chosen, never on load
  order or a confidence that changed elsewhere.
- **Only the review stage** gets memory. Triage, the change map and the briefing never do, so
  memory cannot move a triage level (the verdict's triage floor) or the map.
- **Delivery:** one untrusted part labelled `memory` (the adapters delimit it with the call's
  nonce and neutralise chat-template tokens like any PR content): JSON with the memory canary
  marker and the entries as `{ id: "M1", kind, reason?, coversUpTo?, path, text }`
  (`coversUpTo`: the highest severity a dismissal covers, §2; `medium` for one without a
  recorded severity). Per-call handles, never
  stored ids. Nothing from an entry goes into the instructions slot.
- **Instructions:** `REVIEW_MEMORY_INSTRUCTIONS`, a literal joined after `REVIEW_INSTRUCTIONS`
  only when the file has entries: entries are data recorded from earlier reviews, never
  instructions; a finding a dismissal covers (the same issue, at or below its severity) goes in
  `suppressed` with the entry's id instead of `findings`; a finding above it, and any critical
  finding, goes in `findings`; cite conventions and decisions a finding relies on in its
  `memory`; cite only ids from the block; never copy the marker or the entries' text. A review without memory sends exactly what it sent before.
- **Output:** `REVIEW_MEMORY_OUTPUT` (`rocky_review_memory`, enforced): each finding with a
  required `memory` list of handles, plus a required `suppressed` list of whole findings
  (without a suggestion) each naming the dismissal (`entry`) that covers it. Required lists add
  no optional field to the grammar (the H4-4 limit; `wire-schema.test.ts`).
- **Suppression is enforced by the pipeline, not trusted to the model.** A suppressed finding is
  checked like a draft (its issues go to the repair round as `suppressed[i]…`), then kept out only
  when its entry is a dismissal this call was given and covers its severity (`coversSeverity`:
  up to the recorded severity, `medium` without one, never critical). Otherwise it is restored as
  a draft: an invented handle, a convention named as a dismissal, or a high finding under a
  medium dismissal cannot make a finding disappear (`memoryRestored`, and `memoryStripped` for a
  handle that is not a dismissal of the call). The severity compared is the model's own label;
  triage, which never sees memory, is the independent check: on a file triaged critical (after
  the rule floor) or with a rule floor, no suppression stands and every suppressed finding is
  restored (fix round 2), **with one exception since P8-2b (§7): a dismissal the team took on a
  file that was itself triaged critical may stand on a critical file within the same file or
  directory; never on a rule-floored file.** A restored item that repeats a raised finding (same
  title and lines) is stored once, and carries the double-check marker when the restored copy
  would have (fix round 4, N1). Only conventions and decisions back a raised finding: a
  dismissal cited in a finding's `memory` is stripped. The accepted suppressions are the entries
  "applied without a finding", and each suppressed finding is listed in the document's `hidden`
  (§7): a suppression is never invisible.
- **A suppression restored on a risky file says so (fix round 3).** When a dismissal the call
  was given covers a suppressed finding but no suppression stands on the file, the restored
  draft carries `restored` (schema 1.5, `RestoredDismissal`): the entry as a `MemoryRef`, the
  path the team took the dismissal on, its reason, and why the finding is shown anyway
  (`critical_file` when triage is critical, else `rule_floor`). It is a distinct field, not a
  reuse of `memory`: a dismissal in `memory` is stripped because it would read as backing, and
  this entry argued _against_ the finding. Only the pipeline writes it, from the stored entry:
  the review answer's `ReviewFinding` omits the field, so a model answer that carries it is
  invalid output and the file fails closed. Restorations for any other reason (an invented
  handle, a convention named as a dismissal, a severity above the cap) carry no marker: the team
  did not dismiss those, and "your team dismissed this" would be false. The entry is neither in
  `memoryApplied` nor touched (`last_used_at`): it was not applied. The marker's ref is left out
  of the model text at the final check and checked for a canary fragment like every other ref; a
  reused unit keeps the marker (the stored id and reason, rebuilt from the current entry, dropped
  if the entry is gone). The draft card shows it under the AI mark: "Your team dismissed this as
  intentional on `path` · dismissal · PR #N. This file is critical, so Rocky is showing it anyway:
  double-check." (`apps/web/src/drafts/DraftCard.tsx`; the accepted card, which shows only what
  is posted, does not). `memoryDoubleCheck` counts them.
- **Citations:** handles are resolved against the call's own selection; an unknown handle is
  dropped and counted (`memoryStripped`), never stored. The pipeline builds every `MemoryRef`
  from the stored entry (id, text, `memorySourceLabel`), never from model text: each finding's
  refs, and `briefing.memoryApplied` as their union with the entries applied without a finding
  (in finding, then file order; at most 50). The briefing's "memory applied" section (P6) shows
  them; no new UI.
- **`last_used_at`:** the worker touches the cited entries in the transaction that stores the
  document, and only ids it loaded for this repository.
- **Reuse:** the entries a file's review is given are part of its unit key (`memoryKeyOf`), so a
  new, changed or retired entry re-reviews the file on the next push; without memory the key was
  unchanged, so P8-2 made no `PIPELINE_VERSION` bump (P8-2b bumped it to `p8-2b.1`: the
  double-check marker and the hidden list are new unit outputs, fix round 4 N5). Triage never sees memory, so a unit also stores its
  key without memory (`FileUnit.triageKey`, when it differs): when only the memory changed, the
  previous triage is reused and only the review runs again (`triageReused`). A reused unit keeps its citations: finding refs from
  the previous document, entries applied without a finding from `FileUnit.memoryApplied`
  (optional; older units read as before), both re-filtered to the file's current selection,
  the latter while `suppressionStands` still holds (§7).
- **Estimate:** the memory part is counted for every file sent, as if each were reviewed (an upper
  bound), and in the unit keys the estimate checks for reuse. A file whose triage would be
  reused is still counted whole (an upper bound again).
- **The final check.** The defence-in-depth leak check over the whole document allows what the
  review calls were allowed to quote (the texts of the entries offered), and leaves the
  `MemoryRef`s out of the model text: they are built by the pipeline from stored entries, each of
  which passed `usableMemory`, and are checked on their own for a canary fragment. Two clean
  entries cited together can read as a share of a prompt text that neither reaches alone; they
  must not fail the analysis.

### 5. The memory canary (ADR 0015 R3)

`MEMORY_CANARY` (`rk-canary-memory-8c41d0e7a95b23f6`) sits in every memory part. The leak guard
checks it like the prompt canary (any answer, joined values, never allowed even though it is in
the call's input), so an answer that copies the block is repaired, then fails closed (the file
becomes unanalysed, raising the floor). `containsPromptCanary` and `containsPromptCanaryFragment` (P8-1)
now check both canaries, the latter any run of eight characters of either, so no stored entry can
carry one (or half of one to be rebuilt by two quoted entries); the load-time re-check and the
learner apply the same fragment rule, and the evals' independent check (`check.ts`) looks for it.
`REVIEW_MEMORY_INSTRUCTIONS` joins `PROMPT_TEXTS`.

Entries themselves are **not** leak texts. R3 asked for that for _private_ prompt text. Entry
text is not private relative to the analysis's audience: it comes from the same repository's
pull requests and is shown to the same reviewers. Citations carry it by design, so quoting a
convention is legitimate. The integrity concern (memory as an injection channel) is handled by
§4's structure and §6's tests. The concern that a stored entry could make later analyses fail is
handled by the re-check at load.

### 6. The eval (`packages/evals`, `--memory`)

Two synthetic pull requests of one repository's billing jobs share a pattern the team keeps on
purpose (a per-item `catch` that swallows the error and moves on with no log: what a careful
reviewer usually flags, and what a team may keep when the next nightly run retries every unpaid
item), and each has one unmistakable bug (SQL built by interpolating the org id; an inverted
cutoff comparison that expires fresh payment authorizations and keeps stale ones). The suite
analyses pr-1301 without memory, dismisses the
produced pattern finding as intentional and learns the entry with the real rules, analyses
pr-1302 without memory (the control), then with the entry. The run passes when run 1 raised the
pattern, an entry was learned, the control raised it, run 2 did not, run 2 cites the entry, and
run 2 still finds the real bug. `--memory-trials N` repeats the three analyses for a rate; the
report keeps the conditions over all trials and, per trial and per analysis, the status and
failure code, the case file's triage level, whether it was reviewed, its unanalysed reason, the
count of findings, the matched seeded ids, the pattern's severity and the suppressed and
restored counts (codes, levels, counts and ids only). On `--fake` the model is scripted to obey
the memory block; `memory.test.ts` shows that a model ignoring memory fails it. The gate: once a
baseline passed it, a report must run it and pass. The fake baseline is regenerated with
`--memory` (scores unchanged), and the protected paths and CODEOWNERS include `src/memory/`,
`src/memory.test.ts` and `src/injection/check.ts`, so the PR needs the `evals-baseline-change`
label.

**Triage is pinned (fix round 3).** Every analysis of the eval runs with the case file's triage
pinned to `important` (`pinTriage`, `packages/evals/src/memory/pin.ts`): an eval-harness wrapper
over the triage role that still calls the model, records the level it answered (`modelLevel` in
the report) and hands the pipeline the pinned level with the score moved into its band. Nothing
in the product changes. Pinned, pass/fail measures memory alone: the pattern hidden, the entry
cited, the real bug still found. Triage variance (a `normal` file is never reviewed; on a
`critical` one no suppression stands, by design) had cost two live runs their result, below. The
learn run is pinned too: its only job is to produce the finding to dismiss, and the entry it
teaches depends on the finding's severity, not on the triage level, so one rule for the three
analyses is simpler than an exception. `pinTriage: null` leaves triage to the model (the tests
use it to show the diagnosis, and the critical-file rule). The critical-file rule itself is
checked deterministically on the `--fake` model (`memory.test.ts` "the critical-file rule,
deterministically"): with pr-1302 triaged `critical` and no pin, the fake suppresses the pattern
under the entry and the pipeline restores it with the double-check marker (§4), so the trial
fails with `restored 1, doubleCheck 1` and `run2Raised`.

**Live results so far.** Run 1 (2026-11-05; triage haiku-5-5, review opus-5-5, graph
sonnet-5-5) used an earlier case: a 16-line retry job with a hard-coded `MAX_ATTEMPTS` (rated
low) and a logged email address. Every condition came back false, every analysis `done`, and the
report held booleans only. Diagnosed offline: the review role's 26 calls include the 8 analyses'
briefings, so at most 18 file reviews ran for 25 triaged files; the case files were most likely
triaged `normal`, which is never reviewed, so nothing could be raised. Nothing errored, but the
report could not tell "not reviewed" from "missed". Hence the redesigned case (payment code,
which the triage instructions place at least at `important`, and no rule floor) and the per-run
diagnosis. Run 2 (2026-11-05, the redesigned case with pr-1302 as a receipts mailer): pr-1302 was
triaged `normal` in the control and in run 2 of both trials, never reviewed, so there was nothing
to measure; pr-1302 now releases payment authorizations with an inverted cutoff. Run 3
(2026-11-06, report `packages/evals/reports/live-2026-11-06T00-34-01-796Z.json`): 1 of 2 trials
passed. Trial 1: the control, `important`, raised the pattern and the bug; run 2, `important`,
suppressed the pattern citing the entry and found the bug. Trial 2: run 2 was triaged
`critical`; the model suppressed the pattern, the pipeline restored it (no suppression on a
critical file, by design), and the trial failed. The model followed memory in both trials;
triage variance broke the count, which is what the pin removes. Run 4 (2026-11-06, pinned,
report `packages/evals/reports/live-2026-11-06T13-05-06-089Z.json`): **pass, 2 of 2 trials**,
the evidence for the P8-2 criterion. In both trials the learn run (pinned `important`; the model
said `critical`) raised the pattern and the bug and taught the dismissal; the control (pinned
`important`; the model said `important`) raised both; run 2 (pinned `important`; the model said
`important`) did not raise the pattern, cited the entry and found the bug. The pin changed no
level on pr-1302 in this run; it mattered only for the learn run. The eval stays inconclusive by
design when the control does not raise the pattern, or when run 2 rates the pattern above run 1's
severity (the entry does not cover it); the diagnosis records both.

**What the gate proves.** CI runs the eval on the `--fake` model only: it proves the plumbing
(learning, selection, the untrusted part, enforcement, citations), not that a real model follows
the memory instructions. A live run, `pnpm evals run --memory` with a provider key, is a
**needs-human step before a change to project memory merges**, and its `memory` result is the
evidence for the P8-2 criterion: run 4 above, passed 2/2.

### 7. Suppression on a critical file when the dismissal was taken on one (P8-2b)

Before P8-2b no suppression stood on a file triaged critical, so a team's dismissal taken on
such a file never applied there: the draft came back with the double-check line on every push.
The follow-up lets it stand under guards the pipeline enforces (`suppressionStands`,
`packages/core/src/analysis/memory.ts`), and makes every suppression visible.

- **The learned level.** The learner records the triage level (after the rule floor) the
  dismissed finding's file had in the stored document the reviewer decided on
  (`memory_entries.learned_level`, migration 0021, CHECKed to a learned dismissal and to the four
  levels). It is read from the document's `triage`, never from a request or a model answer, and
  **never travels in the memory part**: the model cannot claim it. Entries learned before P8-2b
  have no level and rank as non-critical, so nothing already learned changes behaviour.
- **The rule, per suppression**, after the severity cap (`coversSeverity`: up to the entry's
  severity, never a critical finding):
  - a file that is not risky: the suppression stands, as before;
  - a rule-floored file (auth, migrations): never, whatever the entry (the floor says the file is
    always reviewed in full; a dismissal learned there would otherwise switch that off);
  - a file triaged critical: only a **learned dismissal** whose `learned_level` is `critical`,
    and only when its evidence path is the same file or the same directory **below the
    repository root** (`nearOnCriticalFile`; fix round 1, S2: root files share the directory
    `""`, so for root-level evidence only the same file counts, or in a flat repository one
    dismissal would stand on every critical file; directories are compared whole, so `src/a` is
    not `src/ab`; a renamed file is judged by its new path, the evidence path is not followed
    through the rename). The team dismissed it in critical context, close by. A
    **member-written entry is not eligible**: it records a person's rule, not a decision taken
    while reviewing a critical file, and by construction it carries no learned level (the
    CHECK); `usableMemory` drops an entry that claims one anyway.
  - **and not against a higher role nearby** (fix round 1, S1, `overruledNearby`): when a
    current learned entry of the opposite kind (a convention or decision), taught by a reviewer
    with a higher role than the dismissal's learner, sits in the reviewed file's directory, the
    suppression is restored with the double-check marker. The learner's own opposite-decision
    rule (§3) matches the exact path and title, so a member's dismissal of a reworded pattern on
    a sibling file slips past it and, with `learned_level = critical`, could hide an owner's
    pattern on the critical file next door. The block is deliberately wider than §3 and
    deterministic: directory and opposite kind, **no subject match**. Titles are model-written
    and vary between runs, so matching subjects would hand the author of the reworded entry a
    way around the block; the cost of blocking is only the double-check line, so the exception
    fails closed. The learner's role travels with the entry (`AnalysisMemoryEntry.learnerRole`,
    from `learner_role`; `null` ranks as member) and, like the level, never reaches the model.
    **With P8-3's controls (ADR 0039, after the rebase):** a person's edit of a learned entry
    keeps the decision's role on the person-written row (migration 0020 dropped 0018's "only
    learned entries carry a role"), so an edited owner convention still blocks; an entry a
    person wrote from scratch carries no role and does not. No edit copies `learned_level`
    (migration 0021's CHECK ties it to a learned dismissal), so a person-written entry never
    stands on a critical file. An entry an admin **switched off**, and every entry of a
    repository whose memory is off, is not loaded for analyses (`disabled_at is null`,
    `repos.memory_enabled`), so it neither stands nor blocks: the switch-off is the admin's
    decision that the entry says nothing any more, and a block from an invisible entry would
    make it partial and unexplainable. The decay job (ADR 0038) and the lazily filled
    `learned_subject` need nothing from this amendment.
    The rule is checked over every entry the analysis was given (300), not only the file's
    selection of 12, so a convention the selection's cap would drop still blocks; and it is
    re-run for a **reused unit's hidden findings** (fix round 2): the unit key covers the
    selection, not the entries the rule reads, so a higher role's entry learned since the last
    push restores the finding on reuse as a fresh review would (the unit then no longer lists
    the entry as applied; every applied entry is re-checked, including one whose suppression
    repeated a raised draft and so had no hidden finding; the double-check marker a fresh run
    would put on that draft cannot be rebuilt on reuse, since the unit does not record which
    draft the suppression repeated: the draft is visible either way). The load bound keeps the blocking entries in reach: owner- and
    admin-taught conventions and decisions load under their own group of 50
    (`ANALYSIS_MEMORY_BOUNDS.learnedOverruling`), so fifty member-taught accepts cannot push an
    owner's older convention out of the window. Chosen over failing closed while the
    learned-other group is truncated: truncation is routine in a busy repository, and failing
    closed there would switch the critical path off silently. What the bound does **not**
    cover: owners and admins together with more than 50 current learned conventions and
    decisions in the repository (the group is shared; the 51st oldest drops out), and entries
    learned before migration 0018, which carry no role and rank as member (they never block).
  - anything else on a critical file: restored with the double-check marker, as fix round 3.
- **Suppressions are never invisible (schema 1.6, `document.hidden`).** Every suppression that
  stands, on any file, is listed in the document as a `HiddenFinding`: the finding's text and
  location (model text, checked like a draft and by the final leak check), under its own `H` id,
  with `hiddenBy` (the dismissal as a `MemoryRef`, the path the team took it on, its reason),
  written by the pipeline from the stored entry. A hidden finding is not a draft: it counts in no
  tally, moves no verdict, and a critical file whose only findings are hidden stays in
  `readByHand`. The entry is in `briefing.memoryApplied` (integrity: `MEMORY_REF_MISMATCH`
  otherwise); a hidden finding whose entry cannot be cited (gone, or past the applied cap), or
  past the document's cap on hidden findings (`MAX_FINDINGS`, fix round 1), is raised as a plain
  draft instead: fail open to the reviewer. A standing suppression that repeats a raised finding
  (same title and lines) is not listed: the draft is enough (fix round 1). Held to the location rules of a
  draft (`UNKNOWN_FILE`, `FINDING_IN_NOISE_FILE`, `FINDING_IN_UNANALYSED_FILE`,
  `LINE_OUTSIDE_DIFF`, `SEVERITY_LEVEL_MISMATCH`). A reused unit keeps its hidden findings,
  rebuilt from the current entry. `memoryHiddenOnCritical` counts the suppressions that stood on
  a critical file.
- **The page shows them.** Under the file's AI strip: "N findings hidden by memory · show"
  (`FileView`, `.hidden-memory`), collapsed; expanded, each is an AI card that is not a draft
  (`HiddenCard`: "AI finding", severity, confidence, title, body, "Your team dismissed this as
  _reason_ on `path` · _source_, so Rocky did not draft it here") with **Restore as a draft**.
  The Review panel lists them under "Hidden by memory", collapsed, each item opening its file on
  the list. The entry's text is not quoted (the title above is the same issue by the model's
  judgement; P8-3's view is where to read the entry).
- **Restore** (`DraftAction` `restore`, `POST …/drafts/:findingId { action: "restore" }`, the
  same route, policy and CSRF as any decision): the store creates the hidden finding's decision
  row, undecided (`findings_state`, state `draft`), and the row's existence is what "restored"
  means: `listReviewDrafts` reports it even undecided, the page then renders it as a draft under
  its line (`restoredAsDraft`: the document's text and location, never the client's), and
  accept, edit, dismiss, undo, send to agent apply as to any draft. Every other action on a
  hidden finding needs the row first (`unknown_finding`, 404, otherwise: the client cannot decide
  what it has not restored); restoring a draft that was never hidden is an `invalid_transition`;
  `applyDraftAction` refuses `restore` (it is not a transition of a decision). A restored finding
  the reviewer accepts is posted like any draft (`draftableFindings` in the plan) and, once
  posted, **teaches a convention that supersedes the dismissal** that hid it (same path and
  subject): the newest human decision wins. Restore is per reviewer and never crosses the org
  (RLS; `not_found`). The restored card says "Your team dismissed this as _reason_ on `path` ·
  _source_. Rocky had hidden it; you restored it."

**What it does not change.** The severity cap, the citation rules, the `not_worth_it` and
critical-severity exclusions, the own-PR rule, role precedence, the 25/300/12 bounds, and the
double-check marker for every other restoration.

## Threat model

**Assets:** the verdict and the findings a human acts on; that memory cannot instruct the model;
tenant boundaries; that people are not named; the pipeline's availability. P8-2b adds: that a
suppression is never invisible, and that the level an entry was learned at is the store's.

**Attackers:** a PR author who steers a model into a finding title that a reviewer then accepts
or dismisses (persisted injection); a member who later writes entries (P8-3); a model
compromised by the memory block; another tenant.

| #   | What can go wrong                                                                                  | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Entry text becomes instructions (persisted prompt injection)                                       | Only as the untrusted `memory` part, JSON, nonce-delimited, chat tokens neutralised by the adapters; instructions are literals; the memory paragraph says entries are data; one line, ≤ 300 characters, no markup, no PR-content markers, no canary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | core `memory.test.ts` "memory text and paths reach the call only as the untrusted memory part"; llm `injection-corpus.test.ts` "corpus case … as a memory entry on the wire" (both wires); evals `memory-injection.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M2  | A model obeying a planted entry changes the verdict, places findings outside the diff or leaks     | Memory reaches only review calls (never triage, map or briefing), so triage levels and the triage floor hold; findings are checked against hunks; leak guard with both canaries; verdict floors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `memory-injection.test.ts`: every corpus payload × 11 adversaries, V1/F1/M1/L1 and clean triage levels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| M3  | Memory hides real problems (a dismissal suppresses later findings)                                 | Dismissals are offered only on their own top-level directory or closer; `not_worth_it` and critical dismissals teach nothing. The pipeline keeps a suppressed finding out only when a dismissal the call was given covers the severity the model gave it (up to the dismissed finding's severity, never critical). **That severity is the model's own label and is otherwise trusted.** The independent signal is triage, which never sees memory: on a file with a rule floor (auth, migrations) no suppression stands; on a file whose triage (after the rule floor) is critical, only a learned dismissal the team took on a file triaged critical, within the same file or directory, stands (§7, `suppressionStands`; the level is the store's, from the stored document, never offered to the model); every other suppressed finding is restored as a draft, and one a dismissal covered is restored **with the double-check marker** (`Finding.restored`: the dismissal, its path and reason, and why; written by the pipeline only, never by a model answer), so the reviewer sees what the team dismissed and why Rocky shows it anyway. **A suppression that stands is listed in `document.hidden` with the entry that hid it**, shown collapsed on the file and in the panel, restorable as a draft (§7). The verdict keeps the triage floor, and a risky file reviewed with no drafts is listed in `readByHand`. Citations show the reviewer which entry was applied; the newest decision wins | core `memory.test.ts` "suppression is enforced by the pipeline", "no suppression on a file triage or the rules call risky" (a critical finding relabelled low is restored on a rule-floored file), "a suppression restored on a risky file says so" (the marker on a rule-floored and on a critical file, none for other restorations, kept on reuse, a model answer carrying it is invalid output), "suppression on a critical file when the dismissal was taken on a critical file (P8-2b)" (the level is not in the memory part; stands same file / same directory, restored one directory over; restored for `important`, `normal`, null and absent levels; never on a rule-floored file; the cap holds; a member-written entry is not eligible and one claiming a level is dropped; the `suppressionStands` table), "a suppression that stands is never invisible" (listed on an ordinary file, no list without one, a hidden finding carrying the canary fails closed, repaired like a draft, kept on reuse, separate ids); `memory-injection.test.ts`; evals `memory.test.ts` "the critical-file rule, deterministically" (restored 1, double-check 1) and "P8-2b: a dismissal taken on a critical file stands on a critical file nearby" (hidden 1, on a critical file 1, cited, bug found); db `memory-learning.test.ts` "records the triage level of the dismissed finding's file" (from the document; the CHECKs); schema `v1-6.test.ts`; web `FileView.test.tsx`, `HiddenCard.test.tsx`, `ReviewPanel.test.tsx`, e2e `drafts.e2e.spec.ts` "hidden by memory (P8-2b)"; the eval's `run2BugFound` |
| M3a | A member teaches repository-wide suppression (dismissing on their own PR, or overturning an admin) | No dismissal is learned when the reviewer's login is the PR author's; a learned entry taught by a higher role is not superseded by a lower one, and a lower role's **opposite** decision about that pattern on the **same path and title** is not stored at all (it would otherwise stay current beside it and, as a dismissal, hide it); on a critical file a lower role's dismissal does not stand against a higher role's entry of the opposite kind in the same directory, whatever the title (§7, `overruledNearby`; re-checked on unit reuse); owner/admin-taught conventions and decisions load under their own bound of 50 so a member's accepts cannot push them out of reach (beyond 50, or for entries learned before 0018 which carry no role, the block does not apply); member-written entries load under their own bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | db `memory-learning.test.ts` "a reviewer who wrote the pull request teaches no dismissal", "an owner's accept is not switched off by a member's later dismissal", "a lower role's opposite decision … is not learned", `loadAnalysisMemory` bounds; core `memory.test.ts` "S1: an owner's accept on a.ts blocks a member's critical-learned dismissal from b.ts on critical a.ts", "the block needs a higher role, the opposite kind, a learned entry, and the same directory", "a reused unit re-checks the block"; db "loadAnalysisMemory bounds" (owner/admin entries the oldest of all, still loaded)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| M3b | A model, a request or a member claims an entry was learned on a critical file                      | `learned_level` is written only by the learner, from the stored document's triage of the finding's file; the memory part carries no level (the model cannot name one); the review answer's schema has no such field; no route writes it; the CHECK ties it to a learned dismissal, so a member-written entry (P8-3) can never carry one; `usableMemory` drops an entry that contradicts the CHECKs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | core "the learned level never reaches the model"; db "records the triage level … from the document" (constraints `memory_entries_learned_level_learned_dismissal`, `_code`); core "a member-written dismissal is not eligible …, and one claiming a learned level is dropped"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| M3c | A hidden finding is forged, misplaced or hides what the leak guard would catch                     | The hidden list is pipeline-written from checked suppressions (the same `check` as drafts, repaired like them); `hiddenBy` comes from the stored entry; the final leak check covers hidden findings' text and their refs' canary fragments; integrity holds them to a draft's location rules and to `MEMORY_REF_MISMATCH`; a hidden finding whose entry cannot be cited is raised as a draft; the list is bounded (`MAX_FINDINGS`, 25 per answer)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | core "hidden findings are model text: one that carries the memory canary fails the file closed", "checked like drafts: an invalid one is repaired"; schema `v1-6.test.ts` (location rules, the ref rule, ids, the bound)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| M3d | A client decides a hidden finding it never restored, restores another org's, or invents one        | `decideDraft` looks the id up in the document's drafts, then its hidden list; a hidden id needs its decision row (created only by `restore`) for any other action (`unknown_finding`); an id the document lacks is `unknown_finding`; a draft that was never hidden cannot be restored (`invalid_transition`); RLS and the org filter (`not_found` across orgs); the restored draft's text and location are the document's (`restoredAsDraft`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | db `drafts.test.ts` "hidden findings are drafts only once restored (P8-2b)" (four tests); server `routes.db.test.ts` "P8-2b: a hidden finding is restored, then decided like a draft; undecidable before that"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| M4  | The model cites an entry it was not given (another repository's, another org's, invented)          | Per-call handles resolved against the call's own selection; unknown handles dropped and counted; refs built from stored entries; touch limited to ids loaded for the repository                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | core "unknown handles are dropped"; worker e2e "sends the repository's entries … touches what was cited" (other org's entry untouched)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| M5  | Another tenant's memory reaches a prompt or is touched                                             | Loaded in the analysis's `withOrg` for `target.repoId` (RLS plus explicit filters); learning reads the submission in its org only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | worker e2e (B's entry never in any call); db `memory-learning.test.ts` "another org's submission does not exist", `loadAnalysisMemory` of B's repo from A is empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| M6  | A stored entry trips the leak guard on every later analysis (availability)                         | Re-check at load drops entries with a canary or prompt text; learning refuses such titles; `containsPromptCanary` refuses both canaries at storage; the final check leaves pipeline-built refs out of model text and allows the offered entries' text, as each call did                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | core "an entry that would trip the leak guard is dropped before it reaches a prompt", "two clean entries cited together do not fail the analysis"; `usableMemory` table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| M7  | Names reach memory                                                                                 | Text from the title only (never the body or the reviewer's edit); store scrubs with members, PR author and reviewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | db "scrubs the PR author and the reviewer out of the learned text"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| M8  | Unbounded growth or cost                                                                           | 25 entries per review, repeats skipped, one current entry per pattern and path; 300 entries per analysis (four bounded groups), 12 per file; the estimate counts the memory part                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | db "a second post … teaches nothing new"; core selection caps; estimate test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M9  | Logs carry entry text                                                                              | Server logs counts and fixed codes (`memory_learned`, `memory_learn_failed`); the worker logs counts (`memoryEntries`, `memoryDropped`, `memoryReviews`, `memoryCited`, `memoryStripped`, `memorySuppressed`, `memoryRestored`, `triageReused`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | server `post-review.db.test.ts` (entry texts absent from the log); worker e2e (marker text absent from logs)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| M8a | Two learners store the same entry twice                                                            | The learner holds the repository's memory lock for its whole run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | db "two learners of the same review at once store each entry once" (fails without the lock)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| M10 | Learning breaks posting                                                                            | Separate transaction after the review is recorded; errors caught and logged as a code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | server tests (posted and reconciled reviews answer as before)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Residual risks

- **Suppression is the feature.** A model that obeys a dismissal entry keeps a finding out in the
  entry's area. An entry whose title was steered by an earlier PR's author, then dismissed by a
  reviewer, can hide a similar finding nearby, up to the severity of the finding it was learned
  from. What holds regardless of the model: no suppression on a file with a rule floor (auth,
  migrations), and on a file triaged critical only for a dismissal the team took on a critical
  file in the same file or directory (§7); elsewhere on such files a covered finding comes back
  as a draft that names the dismissal it overrode; every suppression that stands is listed in
  `document.hidden` and restorable; the verdict's triage floor; `readByHand` for a risky file
  reviewed with no drafts; the critical exclusion; and the citation the reviewer sees. What
  depends on the model: the severity it gives a suppressed finding on any other file. The
  reviewer's own dismissal (never the PR author's, compared by login) and the directory scope
  bound where an entry applies. P8-3's view and delete are the compensating control.
- **P8-2b widens what one reviewer's dismissal can do (judgement call).** A single reviewer who
  dismisses a high finding on a critical file (as intentional, not an issue, or handled
  elsewhere) teaches an entry that can keep a similar finding (by the model's judgement) out of
  the drafts on that file and its directory on later PRs, when triage calls them critical. The
  bounds: never a critical-severity finding; never a rule-floored file; the same file or
  directory only; the learned level is the stored document's, never claimed; the finding is
  listed as hidden with the dismissal that hid it and can be restored in one click; the newest
  decision (restore and accept) supersedes the dismissal; `readByHand` still lists the file when
  nothing is drafted on it; and the own-PR, role and severity rules of §2 and §3 still apply.
  Requiring corroboration from a second reviewer before the critical path applies was
  considered and not adopted for the reason given below ("one reviewer is enough"); P8-3's view
  and delete are the compensating control, and the per-file "hidden by memory" line makes the
  effect visible where it happens.
- **The hidden list quotes the model, not the entry.** A hidden finding's title and body are the
  model's; the page says which dismissal hid it (path, reason, source) without the entry's text.
  A model that matches a dismissal to an unrelated finding on an ordinary file hides it under a
  misleading reason; the reviewer sees the finding anyway (collapsed) and can restore it.
- **Restore is one-way.** A restored finding is a draft until the reviewer decides it; there is
  no "hide again" (dismissing it teaches the dismissal again, which is the same decision).
- **Role precedence is exact-match only.** The opposite-decision rule compares the evidence path
  and the lower-cased finding title exactly. A member's dismissal of the same pattern on a sibling
  path (`src/api/b.ts` after an owner accepted it on `src/api/a.ts`), or under a reworded title
  (titles are model-written and vary between runs), is stored and can suppress a similar finding
  on the owner's file, since "same issue" is the model's judgement. Rule-floored files stay
  protected (no suppression there). On a critical file the gap would have been widened by §7
  (the sibling dismissal, learned at `critical`, could hide the owner's pattern next door), so
  the critical path is blocked by a wider rule: any learned entry of the opposite kind taught by
  a higher role in the same directory restores the finding with the double-check marker
  (`overruledNearby`, no subject match), on fresh and reused units alike, and the higher role's
  entries stay in reach under their own load bound of 50 (beyond it, and for entries learned
  before 0018 that carry no role, the block does not apply). On `normal` and `important` files
  the exact-match gap remains as described; P8-3's view and delete are the compensating
  control.
- **One reviewer is enough to teach.** Requiring a second reviewer to corroborate a dismissal
  before it applies was considered and **not adopted**: most repositories have one reviewer per
  PR, so it would rarely learn anything, and the author rule, the severity cap and the role rule
  bound what one reviewer can teach. P8-3 can revisit it with usage data.
- **A model's severity label is trusted wherever a suppression can stand.** The cap compares
  the severity the model gives the suppressed finding. On a file triaged `normal` or
  `important` without a rule floor, a model that calls a high (or critical) problem "low" to fit
  under a dismissal keeps it out of the drafts. Since §7 the same holds on a file triaged
  critical for an eligible entry (a dismissal the team took on a critical file, in the same
  file or directory, not overruled by a higher role nearby): an injected PR that makes the
  model relabel a real high bug "low" hides it under such a dismissal. What still holds there:
  never a critical-severity finding, never a rule-floored file, the finding is listed under
  "hidden by memory" with the dismissal that hid it and can be restored in one click, and a
  critical file with no drafts stays in `readByHand`. Rule-floored files are not affected (no
  suppression stands there), and the verdict keeps the triage floor.
- **The own-PR rule compares logins** (N7). It is skipped when the mirror's `author_login` is
  null, and it is wrong when the login is stale (a renamed account): then the author's dismissal
  can teach.
- **"Top-level directory" can mean the whole repository** (N8). In a repository whose code all
  lives under one directory (`src/`), relevance 1 covers every file there, so a dismissal is
  offered repository-wide within the other bounds.
- **The model decides what "the same issue" means.** Real models may over- or under-apply a
  dismissal; the live eval measures one case, not a rate. The double-check line inherits this:
  it says the team dismissed "this", meaning the issue the model matched to the entry, and the
  card does not quote the entry's text (the finding's title sits above it; P8-3's memory view
  is where to read the entry). A model that matches a dismissal to an unrelated finding on a
  critical file produces a misleading double-check line when the entry is not eligible there,
  and a hidden finding (listed, restorable, under a misleading reason) when it is (§7).
- **The eval's pin is the harness's, not the product's.** `pinTriage` exists only in
  `packages/evals`; the worker never pins. A pinned run says nothing about how often real triage
  calls the case file critical (where the rule, not memory, decides); `modelLevel` records it.
- **Conventions and decisions are offered on their top-level directory, like dismissals.** They
  can only ask for findings, so they cost tokens and may bias wording, but cannot hide anything.
- **Re-analysis churn (measured).** A new entry re-reviews the files it is offered to on the next
  push, and no others; triage is reused. On ten reviewed files over two top-level directories,
  adding one convention on one of them re-runs 5 reviews and 0 triages, and reuses the other 5
  files whole (core `memory.test.ts` "cache churn from memory"). Before the fix round, an entry
  was offered to every file and changed every unit key: 10 triages and 10 reviews.
- **Learning is best effort:** a server that stops between recording the review and learning
  loses that review's lessons (a later post of the same revision learns them again). A failed
  attempt is not retried (docs/progress.md).

## Consequences

- Core gains `memory-learning.ts` and `analysis/memory.ts`; the pipeline takes
  `AnalysisRequest.memory`; `AnalysisStats` gains nine counts (`memoryDoubleCheck` in fix round
  3); `FileUnit` gains optional `memoryApplied` and `triageKey`; `estimateAnalysisTokens` takes
  `memory`.
- The schema moves to 1.5 (`findings[].restored`, `RestoredDismissal`, stamped only on a
  document that carries one; `docs/schema/analysis-document.md`). Deploy the readers (server,
  web) before the worker that writes it. The review answer's `ReviewFinding` omits the field.
- P8-2b (§7): schema 1.6 (`hidden`, `HiddenFinding`, `HiddenByDismissal`, stamped only on a
  document that lists one; readers first, then the worker); migration 0021
  (`memory_entries.learned_level`); core `suppressionStands`, `hiddenByOf`, `FileRisk`,
  `AnalysisMemoryEntry.learnedLevel`, `AnalysisStats.memoryHiddenOnCritical`, `PIPELINE_VERSION`
  `p8-2b.1`, `DraftAction` `restore`, `restoredAsDraft`, `draftableFindings`; db learner records
  the level, `loadAnalysisMemory` returns it, `decideDraft`/`listReviewDrafts`/the posting plan
  handle restored hidden findings; web `HiddenCard`, the file view's and the panel's "hidden by
  memory" sections, the provider's `hidden`/`restore`/`hiddenBy`/`jumpToHidden`; the eval
  records `hidden`, `hiddenOnCritical` and `pinDecided` (fake baseline regenerated). Fix round 1:
  `learnerRole` on `AnalysisMemoryEntry`, `overruledNearby` and `nearOnCriticalFile`
  (`suppressionStands` takes the analysis's entries), the hidden list capped at `MAX_FINDINGS`
  with the overflow raised as drafts, no hidden copy of a raised finding, and
  `applyKnownFields` drops a model-supplied `hidden` or `restored` (both pipeline-owned).
- The web draft card renders the double-check line (`DraftCard.tsx`, `.evidence.double-check`).
- The db gains migration 0018 (`memory_entries.severity` and `learner_role`, nullable, with
  CHECKs), `learnFromReviewSubmission`, `loadAnalysisMemory`, the learned supersede path and
  `AnalysisTarget.repoId`; the server learns after posting; the worker loads and touches memory.
- The evals gain `--memory`, the memory eval, the corpus through the memory channel, and a fake
  baseline with the memory result.
