# ADR 0039: The project memory page, its controls, and the `context.md` export

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-06
- **Task:** P8-3
- **Amends:** [ADR 0036](0036-project-memory-entries.md) (§4, the seams it left for P8-3: delete,
  the "disabled" switch and the export's author rule), [ADR 0037](0037-learning-and-applying-project-memory.md)
  (§3 and §4: switched-off entries and repositories are neither offered nor learned again)
- **Builds on:** [ADR 0024](0024-org-roles-and-access-policy.md) (`memory.edit` is admin-only,
  the route policy), [ADR 0011](0011-repository-access-check.md) (the P3-6 check on every
  repository route), [ADR 0025](0025-security-headers-and-rate-limits.md) (headers),
  [ADR 0020](0020-github-login-and-sessions.md) (CSRF)

## Context

P8-1 stores memory entries and P8-2 learns and applies them. Both ADRs name the memory page as
the compensating control for what they cannot guarantee: an entry learned from a steered
finding title can suppress similar findings (ADR 0037 residual 1), a name the scrubber missed
is stored (ADR 0036 §2). People must be able to see what Rocky remembers, why, and to correct
or remove it. The plan asks for a memory UI per repository (view, edit, delete, disable) and an
export to `.rocky/context.md` that round-trips.

## Decision

### 1. What can be done, and by whom

| Action                                | Who                                                           | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| View the entries, current and earlier | any member who may review the repository (P3-6 check)         | They already see these entries cited in reviews.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Export `context.md`                   | same                                                          | §3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Edit (kind, text, dismissal reason)   | `memory.edit` (admins, owners), re-checked in the transaction | A new **member-written** entry with the old evidence and confidence supersedes the old one (ADR 0036 §4): history is kept, the text is scrubbed again. A dismissal that stays a dismissal keeps the severity it covers; a switched-off entry stays off. The new entry keeps the old one's **learned subject** and **learner role**, so learning still matches it, and a higher role's decision keeps its precedence, whatever the new text says.                                                                                                                                                                                                                                           |
| Switch an entry off / on              | `memory.edit`                                                 | `memory_entries.disabled_at` (migration 0020). Kept and shown; never offered to a review (`loadAnalysisMemory`); learning does not store **the same kind and subject on the same path** again beside it (otherwise the next reviewer's dismissal would undo the admin's decision); this holds for an edited entry too (the check reads current entries of both origins and matches on the stored `learned_subject`, not on the current text). The opposite decision is still learned, but switched off, whether it replaces a learned entry or stands beside an edited one, so learning never undoes a switch-off in two steps (accept, then dismiss again); only a person switches it on. |
| Delete                                | `memory.edit`                                                 | The entry **and every earlier version** of it (the entries superseded into it, transitively), in one statement under the repository's memory lock. Deleting only the newest would make the previous version current again (`ON DELETE SET NULL`, ADR 0036 residual risks). Embeddings cascade.                                                                                                                                                                                                                                                                                                                                                                                             |
| Switch memory off for the repository  | `memory.edit`                                                 | `repos.memory_enabled` (migration 0020, a Rocky setting the mirror never writes). Off: no entry is offered to a review and `learnFromReviewSubmission` answers `memory_disabled` without learning. The entries stay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Every change is audited (`memory.superseded` + `memory.created` for an edit, `memory.deleted`
with the count, `memory.disabled`/`memory.enabled`, `memory.repo_disabled`/`memory.repo_enabled`;
ids and counts only). The row locks follow learning's order (the repository's advisory lock,
then the rows), so a change and a learner never deadlock and never interleave.

Creating a brand-new entry by hand is **not** part of this task: an entry needs evidence (a
path, a commit, lines and a PR), which a form would have to make the person type. It is a
follow-up (from a PR page, where the evidence is at hand).

### 2. The API (`apps/server/src/memory/routes.ts`)

Routes by the repository's GitHub name, like the PR page (`/api/repos/:owner/:repo/memory…`).
Reads need `pull_requests.review`, changes `memory.edit` (the route policy, ADR 0024), and every
route runs the P3-6 access check before reading anything (503 without it, a denial is the same
404 as an unknown repository). **An entry id must name an entry of the repository in the path**,
checked in the same transaction: access to one repository never reaches another's entries,
even in the same org. Store errors become a SQLSTATE in the log (P8-1 nit 11); logs carry ids,
outcomes and counts, never text, paths or logins. The list answer is the web app's contract
(`MemoryListResponse`, core `memory-api.ts`), validated by the page before anything is shown;
the author is a login or "former member", never a member id.

### 3. The export: a server download, built in core

**Choice: the server answers the markdown as a download** (`GET …/memory/export`,
`content-type: text/markdown; charset=utf-8`, `Content-Disposition: attachment;
filename="context.md"`, `cache-control: no-store`), and the page links to it with
`<a href download="context.md">`. Not a blob built in the browser, because:

- the page needs no extra script, no `blob:` URL and no CSP change (`blob:` would have to be
  allowed somewhere); the answer gets the non-document CSP (`default-src 'none'`) and `nosniff`
  like every API answer, so even a browser that ignored the disposition could run nothing;
- the export reads **all** current entries (up to the per-repository cap), not the page's
  listing of the newest 500;
- the renderer lives in core and is tested once; the server is the only caller.

Rocky never writes the file to its disk and never commits or pushes it: the person downloads
it and commits `.rocky/context.md` themselves.

**Format** (`renderMemoryContext` / `parseMemoryContext`, `packages/core/src/memory-export.ts`):
a heading with the repository, a fixed paragraph, the line `Format: rocky-memory-export 1`, then
`## Conventions`, `## Decisions`, `## Dismissals`, each entry a list item (oldest first, so a new
entry is added at the end and diffs stay small) with fixed sub-items: the dismissal reason and
the severity it covers, the evidence (path, lines, full commit, PR), and the confidence, origin
and whether it is switched off.

**What never goes in:** who taught an entry (a login committed to git cannot be erased when the
person leaves; entries store a member id only, ADR 0036 §3, so this **amends ADR 0036 §4**, which
said to use `memoryAuthorLabel`), entry ids, timestamps (`last used` would change the file on
every review) and any entry whose text or path holds a canary fragment or breaks the store's
text rules (second check; the store already refuses them; the count is logged).

**Entry text and paths are untrusted.** Every character markdown (CommonMark plus GitHub's
tables, strikethrough and math) could read as syntax is backslash-escaped: ``\ ` * _ [ ] < > #
| ~ & ! $``, and a leading `-`, `+`, `=` or `1.`/`1)`. So an entry can never become a heading,
a link or image, HTML or a comment, an entity, a table, another list item or a sub-item that
forges a field. GitHub's autolinks (`https://…`, `www.…`, `name@host`) are broken too: the
`:` before `/`, the `.` after `www` and every `@` are escaped, so nothing in the file becomes a
link. The escaping is its own inverse (`unescapeMarkdownText`). A test renders the export with
a GFM renderer (micromark with its GFM extension, dev dependency) and asserts no link, image,
HTML or heading beyond the file's own, with each entry's text rendered back verbatim.

**Round trip:** `parseMemoryContext(renderMemoryContext(x).markdown)` gives back the same
entries (kind, origin, text, reason, covered severity, evidence, confidence, switched off), in
`exportOrder`. Strict: anything the renderer would not write is refused with its line (the
fixed paragraph is compared exactly and the repository must be a valid `owner/name`); CRLF
line ends are accepted. Tested with text that looks like markdown, HTML and the file's own lines,
paths with syntax characters, a fast-check property over a syntax-heavy alphabet, and through
the server route (`routes.db.test.ts`). An import UI is not part of P8-3 (follow-up).

### 4. The page (`apps/web/src/memory/`)

`/:owner/:repo/memory` (fixture `?source=fixture`, `&as=member`, in development and tests only).
Built from the inbox's frame and the POC's cards, pills, memory mark (◆ in the AI colour),
AI mark (✦ for learned entries; member-written entries stay neutral, since indigo means "you")
and modal. Each entry shows kind, reason and coverage, origin, state (switched off, earlier
version), text, evidence (path, lines, short sha with the full one as a title), the source PR
(a GitHub link built from validated names), confidence, last used and who taught it. Filters:
kind and "show earlier versions". `canEdit` (`can(role, "memory.edit")` from the server) only
hides controls the server would refuse anyway. Delete asks first (Cancel focused, Escape
cancels) and says how many earlier versions go with it; after every change the page loads the
server's list again. Entry strings are React text in `<bdi>`.

The page is reached by its address. A link from the briefing's "Project memory applied" section
is a follow-up: it changes every briefing screenshot baseline, which parallel tasks also touch.

## Threat model (🟢 task; the controls that matter)

| What can go wrong                                                                | Prevention                                                                                      | Test                                                                                                                     |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A member edits, deletes or switches memory                                       | Route policy `memory.edit`; the store re-checks the role with the member row locked             | `policy.db.test.ts` matrix rows; `routes.db.test.ts` "a member cannot change memory"; `memory-controls.test.ts` refusals |
| An entry of a repository the caller cannot read is changed through another's URL | The entry must belong to the path's repository (same transaction); RLS across orgs              | `routes.db.test.ts` "an entry of another repository is not found…"                                                       |
| A delete brings back an older version                                            | The delete takes the whole chain of earlier versions                                            | `memory-controls.test.ts` "deletes the entry with every older version…"                                                  |
| A switched-off pattern comes back through learning                               | Learning skips the same kind and subject on the same path; the opposite is learned switched off | `memory-learning.test.ts` "a pattern an admin switched off is not learned again…"                                        |
| The export injects markdown/HTML into a README-like file, or forges fields       | Every syntax character and autolink escaped; strict parser                                      | `memory-export.test.ts` tricky text, property test, "the export as GitHub renders it"                                    |
| The export leaks people or canaries                                              | No author, id or date; canary fragments dropped                                                 | `memory-export.test.ts`, `routes.db.test.ts` (no login or id in the body)                                                |
| The download is rendered or sniffed as a page                                    | `attachment`, `text/markdown`, `nosniff`, non-document CSP                                      | `routes.db.test.ts` headers                                                                                              |
| Logs carry entry text, paths or logins                                           | Ids, outcomes and counts only; SQLSTATE for store errors                                        | `routes.db.test.ts` "logs ids, outcomes and counts…"                                                                     |

## Consequences

- Migration 0020: `memory_entries.disabled_at`, `memory_entries.learned_subject` (filled for
  existing learned entries from their text, as `memorySubject` derives it; tested against it),
  `repos.memory_enabled` (no grants or policies change). 0018's check that only learned entries
  carry a `learner_role` is dropped, since an edit keeps it. `MemoryEntry` gains `severity` and `disabledAt`.
- The db gains `findMemoryRepository`, `listMemoryEntriesForExport`, `countMemoryEntries`,
  `editMemoryEntry`, `deleteMemoryEntry`, `setMemoryEntryDisabled`, `setRepoMemoryEnabled`;
  `loadAnalysisMemory` and `learnFromReviewSubmission` honour the switches.
- Six routes (two reads with their HEADs, four changes) join the route-permission matrix.

## Residual risks

- A switched-off entry blocks learning only for the same kind, path and subject (exact match
  after folding, as P8-2's supersede rule). A reworded title or a sibling path is learned anew.
- The scrub runs again on an edit, with the current member list; untouched entries are not
  re-scrubbed (ADR 0036 residual; a re-scrub job is still open).
- The export is a snapshot; nothing reads `.rocky/context.md` back into Rocky yet.
- P8-4's decay job (ADR 0038 §4) neither decays nor retires a switched-off entry, nor any entry
  of a repository with memory off; their clocks pause and resume when switched on, so an entry
  switched on after a long time off may decay or retire at the job's next run.
- The no-link proof renders with micromark and its GFM extension, not cmark-gfm, which GitHub
  runs; GitHub's filters after rendering (such as `@mention` links) ignore the escaping. Low
  risk: logins are scrubbed from entries and a file in a repository notifies nobody.
