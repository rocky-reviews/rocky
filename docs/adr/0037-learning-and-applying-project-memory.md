# ADR 0037: Learning project memory from posted reviews and applying it in review prompts

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-05
- **Task:** P8-2
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
  them as `AnalysisRequest.memory`. Three groups are bounded apart, newest first in each:
  member-written entries (100), learned dismissals (100) and other learned entries (50), 250 in
  all (`MAX_ANALYSIS_MEMORY`). A burst of learned entries cannot push out what people wrote, and
  newer conventions cannot push out the dismissals.
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
  handle that is not a dismissal of the call). Only conventions and decisions back a raised
  finding: a dismissal cited in a finding's `memory` is stripped. The accepted suppressions are
  the entries "applied without a finding".
- **Citations:** handles are resolved against the call's own selection; an unknown handle is
  dropped and counted (`memoryStripped`), never stored. The pipeline builds every `MemoryRef`
  from the stored entry (id, text, `memorySourceLabel`), never from model text: each finding's
  refs, and `briefing.memoryApplied` as their union with the entries applied without a finding
  (in finding, then file order; at most 50). The briefing's "memory applied" section (P6) shows
  them; no new UI.
- **`last_used_at`:** the worker touches the cited entries in the transaction that stores the
  document, and only ids it loaded for this repository.
- **Reuse:** the entries a file's review is given are part of its unit key (`memoryKeyOf`), so a
  new, changed or retired entry re-reviews the file on the next push; without memory the key is
  unchanged, so no `PIPELINE_VERSION` bump. Triage never sees memory, so a unit also stores its
  key without memory (`FileUnit.triageKey`, when it differs): when only the memory changed, the
  previous triage is reused and only the review runs again (`triageReused`). A reused unit keeps its citations: finding refs from
  the previous document, entries applied without a finding from `FileUnit.memoryApplied`
  (optional; older units read as before), both re-filtered to the file's current selection.
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

Two synthetic pull requests of one repository share a pattern the team keeps on purpose (a
retry limit as a constant in `src/jobs/`), each with one real bug. The suite analyses pr-1301
without memory, dismisses the produced pattern finding as intentional and learns the entry with
the real rules, analyses pr-1302 without memory (the control), then with the entry. The run
passes when run 1 raised the pattern, an entry was learned, the control raised it, run 2 did not,
run 2 cites the entry, and run 2 still finds the real bug. On `--fake` the model is scripted to
obey the memory block; `memory.test.ts` shows that a model ignoring memory fails it. Live, the
same three analyses measure the real model. The gate: once a baseline passed it, a report must
run it and pass. The fake baseline is regenerated with `--memory` (scores unchanged), and the
protected paths and CODEOWNERS include `src/memory/`, `src/memory.test.ts` and
`src/injection/check.ts`, so the PR needs the `evals-baseline-change` label.

**What the gate proves.** CI runs the eval on the `--fake` model only: it proves the plumbing
(learning, selection, the untrusted part, enforcement, citations), not that a real model follows
the memory instructions. A live run, `pnpm evals run --memory` with a provider key, is a
**needs-human step before merge**, and its `memory` result is the evidence for the P8-2
criterion.

## Threat model

**Assets:** the verdict and the findings a human acts on; that memory cannot instruct the model;
tenant boundaries; that people are not named; the pipeline's availability.

**Attackers:** a PR author who steers a model into a finding title that a reviewer then accepts
or dismisses (persisted injection); a member who later writes entries (P8-3); a model
compromised by the memory block; another tenant.

| #   | What can go wrong                                                                                  | Prevention                                                                                                                                                                                                                                                                                                                                                                        | Test                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | Entry text becomes instructions (persisted prompt injection)                                       | Only as the untrusted `memory` part, JSON, nonce-delimited, chat tokens neutralised by the adapters; instructions are literals; the memory paragraph says entries are data; one line, ≤ 300 characters, no markup, no PR-content markers, no canary                                                                                                                               | core `memory.test.ts` "memory text and paths reach the call only as the untrusted memory part"; llm `injection-corpus.test.ts` "corpus case … as a memory entry on the wire" (both wires); evals `memory-injection.test.ts` |
| M2  | A model obeying a planted entry changes the verdict, places findings outside the diff or leaks     | Memory reaches only review calls (never triage, map or briefing), so triage levels and the triage floor hold; findings are checked against hunks; leak guard with both canaries; verdict floors                                                                                                                                                                                   | `memory-injection.test.ts`: every corpus payload × 11 adversaries, V1/F1/M1/L1 and clean triage levels                                                                                                                      |
| M3  | Memory hides real problems (a dismissal suppresses later findings)                                 | Dismissals apply only near where they were taken (top-level directory or closer); `not_worth_it` and critical dismissals teach nothing; a dismissal covers only up to the dismissed finding's severity, never critical, **enforced by the pipeline** (a suppression it does not cover is restored); citations show the reviewer which entry was applied; the newest decision wins | core `memory.test.ts` "suppression is enforced by the pipeline"; `memory-injection.test.ts` (an adversary suppressing everything under a dismissal: high and critical findings stored); the eval's `run2BugFound`           |
| M3a | A member teaches repository-wide suppression (dismissing on their own PR, or overturning an admin) | No dismissal is learned when the reviewer authored the PR; a learned entry taught by a higher role is not superseded by a lower one; member-written entries load under their own bound                                                                                                                                                                                            | db `memory-learning.test.ts` "a reviewer who wrote the pull request teaches no dismissal", "taught by a higher role is not superseded", `loadAnalysisMemory` bounds                                                         |
| M4  | The model cites an entry it was not given (another repository's, another org's, invented)          | Per-call handles resolved against the call's own selection; unknown handles dropped and counted; refs built from stored entries; touch limited to ids loaded for the repository                                                                                                                                                                                                   | core "unknown handles are dropped"; worker e2e "sends the repository's entries … touches what was cited" (other org's entry untouched)                                                                                      |
| M5  | Another tenant's memory reaches a prompt or is touched                                             | Loaded in the analysis's `withOrg` for `target.repoId` (RLS plus explicit filters); learning reads the submission in its org only                                                                                                                                                                                                                                                 | worker e2e (B's entry never in any call); db `memory-learning.test.ts` "another org's submission does not exist", `loadAnalysisMemory` of B's repo from A is empty                                                          |
| M6  | A stored entry trips the leak guard on every later analysis (availability)                         | Re-check at load drops entries with a canary or prompt text; learning refuses such titles; `containsPromptCanary` refuses both canaries at storage; the final check leaves pipeline-built refs out of model text and allows the offered entries' text, as each call did                                                                                                           | core "an entry that would trip the leak guard is dropped before it reaches a prompt", "two clean entries cited together do not fail the analysis"; `usableMemory` table                                                     |
| M7  | Names reach memory                                                                                 | Text from the title only (never the body or the reviewer's edit); store scrubs with members, PR author and reviewer                                                                                                                                                                                                                                                               | db "scrubs the PR author and the reviewer out of the learned text"                                                                                                                                                          |
| M8  | Unbounded growth or cost                                                                           | 25 entries per review, repeats skipped, one current entry per pattern and path; 250 entries per analysis, 12 per file; the estimate counts the memory part                                                                                                                                                                                                                        | db "a second post … teaches nothing new"; core selection caps; estimate test                                                                                                                                                |
| M9  | Logs carry entry text                                                                              | Server logs counts and fixed codes (`memory_learned`, `memory_learn_failed`); the worker logs counts (`memoryEntries`, `memoryDropped`, `memoryReviews`, `memoryCited`, `memoryStripped`, `memorySuppressed`, `memoryRestored`, `triageReused`)                                                                                                                                   | server `post-review.db.test.ts` (entry texts absent from the log); worker e2e (marker text absent from logs)                                                                                                                |
| M8a | Two learners store the same entry twice                                                            | The learner holds the repository's memory lock for its whole run                                                                                                                                                                                                                                                                                                                  | db "two learners of the same review at once store each entry once" (fails without the lock)                                                                                                                                 |
| M10 | Learning breaks posting                                                                            | Separate transaction after the review is recorded; errors caught and logged as a code                                                                                                                                                                                                                                                                                             | server tests (posted and reconciled reviews answer as before)                                                                                                                                                               |

### Residual risks

- **Suppression is the feature.** A model that obeys a dismissal entry keeps a finding out in the
  entry's area. An entry whose title was steered by an earlier PR's author, then dismissed by a
  reviewer, can hide a similar finding nearby, up to the severity of the finding it was learned
  from. It is bounded by the reviewer's own dismissal (never the author's), the directory scope,
  the severity cap and critical exclusion the pipeline enforces, and the citation the reviewer
  sees. P8-3's view and delete are the compensating control.
- **One reviewer is enough to teach.** Requiring a second reviewer to corroborate a dismissal
  before it applies was considered and **not adopted**: most repositories have one reviewer per
  PR, so it would rarely learn anything, and the author rule, the severity cap and the role rule
  bound what one reviewer can teach. P8-3 can revisit it with usage data.
- **A model may still mislabel severity.** The cap compares the severity the model gives the
  suppressed finding; a model that calls a high problem "low" to fit under a dismissal is not
  caught by the cap (the critical exclusion and the triage floor still hold).
- **The model decides what "the same issue" means.** Real models may over- or under-apply a
  dismissal; the live eval measures one case, not a rate.
- **Learned convention entries are offered repository-wide.** Like any convention, they can
  only ask for findings, so they cost tokens and may bias wording, but cannot hide anything.
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
  `AnalysisRequest.memory`; `AnalysisStats` gains eight counts; `FileUnit` gains optional
  `memoryApplied` and `triageKey`; `estimateAnalysisTokens` takes `memory`.
- The db gains migration 0018 (`memory_entries.severity` and `learner_role`, nullable, with
  CHECKs), `learnFromReviewSubmission`, `loadAnalysisMemory`, the learned supersede path and
  `AnalysisTarget.repoId`; the server learns after posting; the worker loads and touches memory.
- The evals gain `--memory`, the memory eval, the corpus through the memory channel, and a fake
  baseline with the memory result.
