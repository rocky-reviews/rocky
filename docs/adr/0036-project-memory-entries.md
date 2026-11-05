# ADR 0036: Project memory entries, with evidence, a PII scrubber and no names

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-05
- **Task:** P8-1 (storage, domain and safety controls; learning and prompt use are P8-2, the UI
  and export P8-3, decay P8-4)
- **Builds on:** [ADR 0003](0003-tenancy.md) (every tenant table has `org_id` + RLS, composite
  foreign keys, only inside `withOrg`), [ADR 0005](0005-migrations-and-roles.md) (roles, erasure
  through `retention.delete_org`), [ADR 0009](0009-installation-lifecycle.md) (org erasure),
  [ADR 0015](0015-prompt-injection-defence.md) (PR content is untrusted, the prompt canary),
  [ADR 0024](0024-org-roles-and-access-policy.md) (`memory.edit` is admin-only; members are
  removed with a durable `removed_at`), [ADR 0027](0027-review-drafts.md) (dismissal reasons are
  fixed codes)

## Context

Rocky should remember what a repository's reviewers have decided: conventions ("the shared
validator handles emails"), decisions ("we keep the legacy endpoint until Q2") and dismissals
("findings about intentional `any` in the test helpers are not issues"). P8-2 learns such entries
from dismissals and accepted findings and quotes them in review prompts with citations; P8-3
shows, edits and exports them; P8-4 decays them. P8-1 is the storage and the safety controls
those three build on.

Memory is a new kind of data: it is **derived from PR content** (titles, comments, code and the
model's findings, all untrusted), it is **fed back into prompts** (so it is a persistent prompt
injection channel), it is **about people's decisions** (so it tends to carry names, logins and
emails), and it **outlives the PR** it came from (so retention and erasure must cover it). The
plan's acceptance criteria are: PII scrubber tests, and "deleting a user makes their entries show
'former member'".

## Decision

### 1. Data model (migration 0017)

`memory_entries` (since 0002) gets its real shape. One row per entry, per repository:

| Column                                                            | Rule                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org_id`, `repo_id` (NOT NULL)                                    | Tenant and repository; composite FK to `repos`, cascade. Org-wide entries do not exist: the evidence is a PR of one repository, and P8-3 views and exports per repository.                                                                         |
| `kind`                                                            | `convention`, `decision` or `dismissal` (CHECK)                                                                                                                                                                                                    |
| `origin`                                                          | `member` (a person wrote it, P8-3) or `learned` (P8-2 derived it from a decision the member made) (CHECK)                                                                                                                                          |
| `content`                                                         | The entry's text: one line, 1..300 characters (`MAX_MEMORY_TEXT_LENGTH`, the same cap as the quote in a finding's `MemoryRef`), scrubbed before it is stored (§2), no control characters (CHECK), no invisible characters or markdown links (core) |
| `evidence_path`, `evidence_sha`, `evidence_start`, `evidence_end` | Where the evidence is: a repository-relative POSIX path (no leading `/`, no `\`, no `.`/`..` segment; CHECK plus the schema's `pathProblem` in core), a full lowercase sha (CHECK), an inclusive 1-based line range of at most 200 lines (CHECK)   |
| `source_pr_number`                                                | The PR the evidence comes from, by number (CHECK 1..10⁹). Not a foreign key: GitHub is the source of truth and the mirror row may be rebuilt; the entry must not disappear with it.                                                                |
| `confidence`                                                      | Integer 0..100 (CHECK), the schema's `Confidence` scale. P8-2 decides the values; P8-1 only stores them.                                                                                                                                           |
| `reason`                                                          | The dismissal reason code (`not_an_issue`, `intentional`, `not_worth_it`, `handled_elsewhere`), present exactly when `kind = 'dismissal'` (CHECK)                                                                                                  |
| `created_by`                                                      | The member id of the author, never a login or a name. FK `(org_id, created_by) → members (org_id, id) ON DELETE SET NULL` (since 0002).                                                                                                            |
| `last_used_at`                                                    | When a review last cited the entry (`touchMemoryEntries`); `NULL` until then. P8-4's decay input.                                                                                                                                                  |
| `superseded_by`                                                   | The entry that replaced this one: composite FK to the same table (same org by construction), `ON DELETE SET NULL`, never itself (CHECK). A superseded entry is kept as history and is left out of listings by default.                             |

Index `(org_id, repo_id, created_at)` for the per-repository listing. The old `source jsonb`
column is dropped; nothing in the product had written the table before P8-1 (fixtures only), so
the migration empties it before adding the NOT NULL columns and says so.

Invariants live in `packages/core/src/memory.ts` (`prepareMemoryEntry`: kinds, origins, the
evidence rules, the confidence range, the reason pairing, the text rules after scrubbing) and are
repeated as CHECK constraints, so a bug in a caller cannot store a malformed row. The repository
(`packages/db/src/memory.ts`: `createMemoryEntry`, `listMemoryEntries`, `loadMemoryEntry`,
`supersedeMemoryEntry`, `touchMemoryEntries`) runs only inside the caller's `withOrg`
transaction; creating and superseding are audited (`memory.created`, `memory.superseded`, ids and
counts only). The entry's **origin is the caller's parameter**, never read from the untrusted
entry. An entry is created by an active member for a repository of the org, both re-checked in
the writing transaction with the actor's member row locked `FOR SHARE` (the T37 precedent): a
member-written entry (`origin: "member"`) and a supersede need `memory.edit` (admins and owners,
ADR 0024), answered `not_permitted` otherwise; a learned entry needs its author to be an active
member (any role can dismiss a draft). Creates run under a per-repository advisory lock so the
per-repository cap (`MAX_MEMORY_ENTRIES_PER_REPO`, 5 000) holds under concurrency. Superseding locks both rows,
requires the same repository, refuses a self-reference and a target that is itself superseded,
which also rules out cycles (every entry in a chain except its head is superseded, and the source
must not be).

### 2. The PII scrubber (`packages/core/src/pii.ts`)

Every entry text passes through `scrubPersonalIdentifiers(text, { people })` before it is
validated or stored. It is deterministic and pure. In order, on a canonical copy of the text
(NFKC, invisible and format characters removed, a small table of Cyrillic/Greek look-alikes folded
to Latin for matching only):

1. git trailers (`Co-authored-by:`, `Signed-off-by:`, `Reviewed-by:`, …): the whole value;
2. email addresses: plain, Unicode, URL-encoded (`%40`), obfuscated (`[at]`, `(at)`, `{at}`,
   `[dot]`, "at … dot …") and the `Name <email>` form (name and address);
3. userinfo in URLs (`https://alice:secret@host`);
4. `@handles` (GitHub login shape), except npm scopes (`@types/node`), decorator calls
   (`@Inject(`), dotted decorators (`@app.route`, `@functools.cache`: a login cannot contain a
   dot), CamelCase decorators with two humps (`@HostBinding`; `@Alice` stays a person) and a list
   of JSDoc tags, CSS at-rules and common annotations (`@param`, `@media`, `@Override`); a
   listed login after `@` is always a person, allow-list or not;
5. **known people**: the logins and display names the caller passes. The repository puts the
   author login of the source PR and every member login of the org (active or removed) first
   and the caller's list after; more than `MAX_KNOWN_PEOPLE` (50 000) distinct folded names is
   refused (`too_many_people`), never scrubbed with a shortened list. People are matched by
   **word lookup**, not by a compiled pattern: the text is split into words once, each word is
   looked up in an index (keyed by the first three words) of the names and of every
   space-separated part of a display name, trimmed of punctuation, with hyphenated sub-parts
   (`Smith` of `Smith, Alice`, `Ally` of `Alice "Ally" Smith`, `Smith` and `Jones` of `Alice
Smith-Jones`; a login's hyphenated words such as `the` in `bob-the-builder` are not parts),
   and a multi-word name must match word by word with the same text in between. Everything is case-insensitive: logins, whole display names and their parts
   (`smith`, `SMITH` and `Smith` of `Alice Smith`). A name or part is matched **wherever it
   appears as a word** unless it is "weak" (`matchesAsBareWord`): an ASCII word in a small
   dictionary of common words and word-names (`go`, `api`, `main`, `test`, `Mark`, `Brown`),
   in the stop list, or at most two letters (`Li`). A weak name is matched only in person
   positions: after `@`, after a cue, before a speech verb, in a trailer. So member logins `go`
   and `main` do not turn "run on main, call the api from go code" into placeholders, `thanks
go` and `@main` are scrubbed (inside backticks too), and `john`, `bob`, `anna`, `Eric Li`
   and `Pérez` are scrubbed wherever they appear. Possessives (`Alice's`) are included;
   identifiers that contain a name (`aliceValidator`, `alice_id`, `malice`) are not touched;
   inline code does not protect a listed person;
6. names after honorifics (`Dr. DeAndre Jones`, `Mr. O'Neil`) and after attribution cues
   (`thanks`, `cc`, `according to`, `reviewed by`, …): a capitalised word of any letters
   (`DeShawn`, `McKenzie`, `Jean-Luc`, `O'Brien`), the stop list keeping sentence starters,
   roles, products and tools out (`Prettier wants`, `according to Drizzle docs`); names before
   speech verbs (`Alice suggested`): a capitalised word with lower-case letters after the
   capital, allowing the usual prefixes (`McDonald`, `DeShawn`), apostrophe parts (`O'Brien`,
   `De'Andre`) and hyphenated parts (`Jean-Luc`), never CamelCase (`HttpClient said` is code).
   Never an acronym (`per RFC`); a match never ends inside a word; verb forms that double as
   plural nouns (`requests`, `notes`, `comments`, `reviews`, `mentions`, `replies`) are not
   speech verbs (`Logger notes the id` stays, and so does `Alice notes the id` unless Alice is
   listed); these context heuristics do not look inside inline code (backticks); listed people
   and `@handles` are scrubbed there too;
7. phone numbers: 9–15 digits with separators or a leading `+`, never a date, a line range, a
   version, a sha or a bare number;
8. IPv4 addresses.

Each class is replaced by a fixed placeholder (`[person]`, `[email]`, `[user]`, `[phone]`,
`[address]`); the result reports counts per class, which is all a log may carry.

**What the scrubber guarantees:** the known people (member logins, display names passed by the
caller, the PR author, and every space-separated or hyphenated part of a display name, trimmed
of punctuation) are never stored wherever they appear as a word, in any case, possessive, NFKC
or look-alike spelling, with invisible characters inside or inside inline code, **except** a
name or part that is a dictionary or stop-list word or at most two letters, which is removed
only in person positions (after `@`, a cue, in a trailer, before a speech verb; inside inline
code too); email addresses,
URL credentials, `@handles`, trailer values, phone numbers and IPv4 addresses of the listed
shapes are never stored; no entry carries the prompt canary or any eight-character run of it.
The output is NFKC without invisible characters, which also removes the hidden-text channel into
prompts. The property test in `pii.test.ts` states the first guarantee over random logins of
every length.

**What it cannot guarantee (honestly):** a name that is not in the list and is not next to a cue
is a word like any other (`Pat merged it` is replaced because of the speech verb, `Pat's branch`
is not); a listed login or token that is a dictionary word or at most two letters survives
outside person positions (`go`, `pat`, `Li` in "Li alone" survive; `cc Li` does not); a verb
form that is also a plural noun is not a cue (`Pat notes the id` stays unless Pat is listed);
a product, brand or CamelCase word after a cue is a false positive (`according to HttpClient
docs` stores `according to [person] docs`, `thanks OpenAPI spec` and `according to GraphQL`
likewise: the safe side), never a partial word; a CamelCase `@handle` alone on its line is kept
as decorator syntax; names in scripts without letter case (CJK, Arabic, Hebrew) are only caught when listed;
a person can be identified without a name ("the CTO", "whoever wrote the auth module", a
unique role or date); IPv6, postal addresses, national ids, usernames inside URLs
(`github.com/alice`) and names inside code identifiers are not recognised; a display-name part
that is a dictionary word is removed only in person positions (`Mark the field` with a member
"Mark Brown" stays as written; `cc Mark` does not); `@param`-like allow-listing is a list, so an
unusual tag is scrubbed (`@fixme` → `[user]`), which is the safe failure. The scrubber is a
safety net; the controls are that entries are built from fixed codes and prose a reviewer sees
and can edit (P8-3), that people are referenced by member id only, and that evidence is a path,
a sha and a range, never text.

Evidence paths are not scrubbed: a repository path is what git reports and is already stored in
the mirror; a path that names a person (`docs/people/alice.md`) is the repository's choice. Evidence paths and entry text both refuse
the prompt canary in every spelling the leak guard folds (`containsPromptCanary`, spaced, cased,
other scripts' digits, look-alikes): a stored entry quoted into a finding must never fail the
guard for every later review.

### 3. "Former member"

Nothing about a person is stored in an entry but their member id. The reader joins `members`
and answers `author: { kind: "member", memberId, login }` while the member row exists and is not
removed, and `author: { kind: "former_member" }` when the row is gone (`created_by` is `NULL`,
the FK's `ON DELETE SET NULL`) or carries `removed_at` (ADR 0024's durable removal, which keeps
the row). `memoryAuthorLabel` (core) renders the latter as "former member". A restored member is
shown by login again. There is nothing to erase in `memory_entries` when a person leaves, and the
display never has to be rewritten: that is the whole point of storing an id.

Erasure of an org (`retention.delete_org`) cascades through `memory_entries` and `embeddings`
like every tenant table (no change needed; `deletion.test.ts` and `memory.test.ts` check it).
Entries are knowledge, not logs, so they are not time-bounded by `app.retention_settings`; P8-4
owns their lifetime (`last_used_at`, `superseded_by` and `confidence` are its inputs).

### 4. Seams for P8-2, P8-3 and P8-4

- **P8-2 (learning and prompts):** `createMemoryEntry(tx, { authorMemberId, repoId, origin:
"learned", entry, people })` with `reason` for dismissals and `people` for the logins the
  learner saw (PR commenters, reviewers; `too_many_people` past 5 000 distinct, so batch or
  pick), the author being the member whose decision is learned; `listMemoryEntries(tx, { repoId })` for the current entries of a
  repository; `touchMemoryEntries` after a review cited entries; `memorySourceLabel(entry)` for
  a `MemoryRef.source` ("decision · PR #612"). Entries must enter prompts as untrusted text
  (`LlmUntrustedText`, ADR 0015), never as instructions; their text refuses the prompt canary and
  PR-content markers at storage so a stored entry cannot trip the leak guard or forge a block.
- **P8-3 (UI and export):** `origin: "member"` (admins and owners only: `memory.edit` is
  re-checked in the transaction), `listMemoryEntries(…, { includeSuperseded })`
  and `loadMemoryEntry`; `supersedeMemoryEntry` is the edit path (an edit is a new entry that
  supersedes the old one, so history is kept); deletion and a per-repository "disabled" switch
  are P8-3's (the app role already holds DELETE; `embeddings` cascade). The export must use the
  stored text as is (already scrubbed) and `memoryAuthorLabel` for authors.
- **P8-4 (decay):** `last_used_at`, `created_at`, `confidence` and `superseded_by` are in place;
  the job must run per org inside `withOrg` (never cross-tenant SQL); the isolation suite already
  enumerates both tables.

## Threat model

**Assets:** entry text (prompt input, shown to reviewers, exported), the people behind entries,
tenant boundaries, the audit trail, the analysis pipeline's availability.
**Attackers:** another tenant (through the API or a bug); PR content steering the model and,
through P8-2, the memory (persisted prompt injection); a member trying to plant text into other
reviewers' prompts; a leaver whose name must not remain; anyone reading an export or a log.

| #   | What can go wrong                                                                                                                                                                                                                   | Prevention                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Test                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Org A reads, lists, supersedes, touches or deletes org B's entries                                                                                                                                                                  | RLS on `memory_entries` and `embeddings` (0003); every repository function runs inside `withOrg` and filters by `tx.orgId` as defence in depth; `superseded_by`, `repo_id` and `created_by` are composite `(org_id, …)` foreign keys, so a row can never point at another tenant's row                                                                                                                                                                                 | `isolation.test.ts` (both tables in every per-table check; "memory entries (P8-1)": cross-org supersede, FK violation, list and touch answer nothing); `memory.test.ts` "another org's rows do not exist"                                                                                                             |
| P2  | A name, login or email is stored in an entry and must be erased when the person leaves; a long caller list pushes the known people out of the scrub                                                                                 | `created_by` is an id; the scrubber removes the PR author, every member login of the org and then the caller's people before storage, and refuses past 5 000 distinct names instead of shortening; the reader derives "former member" from the member row                                                                                                                                                                                                              | `pii.test.ts` (table of cases, property test: a listed person never survives), `memory.test.ts` "stores no login", "a deleted member shows as former member", "a removed member shows as former member", "refuses more distinct people than the scrubber accepts, and puts the known ones first", superuser row check |
| P3  | Poisoned memory: PR content steers the model into a finding that P8-2 turns into an entry that instructs later reviews; or an entry carries the canary so every later review that cites it fails the leak guard (denial of service) | Entry text is one line of at most 300 characters, NFKC, without invisible characters, markdown images or links (schema `line` rules), without the prompt canary in any spelling the leak guard folds (`containsPromptCanary`, text and evidence path) or `<pr_content` markers; kinds, origins and reasons are fixed codes set by the caller; only a member can create an entry (`memory.edit` for written ones); P8-2 must quote entries as untrusted text (seam, §4) | `memory.test.ts` (core) "refuses the prompt canary in every spelling the leak guard folds…" (spaced, upper-case, full-width, look-alike, other digits, hidden characters; text and path), "refuses invisible characters and links"; `memory.test.ts` (db) CHECK constraints, "re-checks memory.edit…"                 |
| P4  | PII leaks into prompts or exports through an entry that bypassed the scrubber                                                                                                                                                       | The repository is the only writer and always scrubs; the stored text is what P8-2 quotes and P8-3 exports; there is no raw-text column                                                                                                                                                                                                                                                                                                                                 | `memory.test.ts` "every create goes through the scrubber (member logins, PR author, caller's people)"; schema-drift test (no other text column)                                                                                                                                                                       |
| P5  | Unbounded growth: a learner or a member fills a repository with entries, or a listing reads them all                                                                                                                                | Per-repository cap (5 000) under an advisory lock; listing capped at 500 and touch at 500 ids; text capped at 300 characters                                                                                                                                                                                                                                                                                                                                           | `memory.test.ts` "refuses the 5 001st entry of a repository", "lists at most MAX_MEMORY_LISTING"                                                                                                                                                                                                                      |
| P6  | Supersede cycles or a chain that never ends                                                                                                                                                                                         | The target must be a current (not superseded) entry of the same repository and not the source itself; the CHECK refuses a self-reference for every role                                                                                                                                                                                                                                                                                                                | `memory.test.ts` "supersede: self, already superseded, different repo, cycle"                                                                                                                                                                                                                                         |
| P7  | Logs or errors carry entry text, evidence or names                                                                                                                                                                                  | Store errors are fixed messages; results are codes; the scrub report is counts; the audit metadata holds kind, repo id, origin and counts                                                                                                                                                                                                                                                                                                                              | `memory.test.ts` "stores a scrubbed entry… answers the view" (audit row asserted); the server (P8-3) inherits the rule                                                                                                                                                                                                |
| P8  | A malformed entry (bad sha, range, path, confidence) reaches the database through a future caller                                                                                                                                   | CHECK constraints mirror the core rules                                                                                                                                                                                                                                                                                                                                                                                                                                | `memory.test.ts` "the database refuses what core refuses"                                                                                                                                                                                                                                                             |
| P9  | The scrubber is fooled by an obfuscated spelling of a known person                                                                                                                                                                  | NFKC, invisible characters removed, look-alike folding, case-insensitive logins, possessives; `@` and email forms handled before names                                                                                                                                                                                                                                                                                                                                 | `pii.test.ts` Unicode and obfuscation rows                                                                                                                                                                                                                                                                            |
| P10 | The scrubber destroys code conventions (false positives)                                                                                                                                                                            | Identifier boundaries (letters, digits, `_`), npm scopes, decorators and tag allow-list, acronym and stop-word rules, date/range/version/sha exclusions                                                                                                                                                                                                                                                                                                                | `pii.test.ts` false-positive rows                                                                                                                                                                                                                                                                                     |
| P11 | Erasing an org leaves memory or embeddings behind                                                                                                                                                                                   | `org_id … ON DELETE CASCADE` on both tables; `delete_org` deletes the org row                                                                                                                                                                                                                                                                                                                                                                                          | `deletion.test.ts` (every public table empty), `memory.test.ts` "erasure removes entries and embeddings"                                                                                                                                                                                                              |

## Consequences

- A migration (0017) with the new shape; the test fixture seeds a full entry; the Drizzle schema
  mirrors it.
- Core gains `memory.ts` and `pii.ts` (pure; fast-check property test on the scrubber).
- The repository API is small on purpose: P8-3's delete/disable and P8-4's decay add to it.
- The scrubber's limits (§2) are documented and tested; reviewers see entries before they are
  exported (P8-3), which is the compensating control.

## Residual risks

- The scrubber is a heuristic for anything not in the known-people list (§2). Memory text is
  shown to the repository's reviewers and exported to the repository (`.rocky/context.md`,
  P8-3), both audiences that already see the PR; the residual exposure is a name reaching a
  prompt. A per-org option to refuse entries with any capitalised bigram is a follow-up if that
  proves insufficient.
- `removeMember` keeps the member row (its `login` is display data, ADR 0024); "former member"
  is derived at read time, so the login is still in `members` until the org is erased. That is
  ADR 0024's decision, not this one's.
- The per-repository cap is a ceiling, not a budget: P8-4 decides what to keep.
- `MAX_KNOWN_PEOPLE` (50 000 distinct folded names) bounds the scrub's people list, and
  `MAX_KNOWN_PEOPLE_ENTRIES` (250 000 names, parts and hyphenated sub-parts examined per call,
  deduplicated or not) bounds the work and memory whatever the names look like; both are
  constants with timing tests and both answer `too_many_people`, never a shortened list. 50 000
  three-word names fit (200 000 entries); 50 000 five-word names, fifty one-letter words or
  twelve hyphenated parts do not and are refused in about 100–350 ms. The index is keyed by the
  first three words and a key with more than `MAX_KNOWN_PEOPLE_PER_KEY` (256) names is refused,
  so names sharing a prefix cannot make a scrub quadratic. Measured per call (index + scrub, a
  laptop, transient heap): 50 000 one-word names 56 ms / 31 MB; two-word 187 ms / 98 MB;
  three-word 254 ms / 108 MB; 50 000 `John Smith …` names over 2 000 characters of `john smith`
  180 ms / 85 MB; 50 000 weak `Go Go …` names over 2 000 characters 137 ms / 66 MB; 50 000
  `John Smith Jr …` names refused in 1 ms. The regex alternation this replaced took seconds and
  ran out of memory at that size.
  with more members than that gets `too_many_people` on every create (audited nowhere, answered
  to the caller) until the constant is raised; nothing is scrubbed with a shortened list. No
  GitHub organization Rocky targets is near that size; the way out is a code change with the
  timing test, or (P8-3) a per-org setting that passes active members only.
- `superseded_by … ON DELETE SET NULL`: deleting the newer entry (P8-3) makes the older one
  current again. P8-3 should delete a chain, or supersede instead of deleting.
- **Scrubbing happens at write time only.** A person who joins the org later, or a login that
  is renamed, is not removed from entries written before; and a member who leaves keeps their
  login in `members` (ADR 0024), so the scrub of later entries still knows them. A re-scrub of a
  repository's entries with the current member list is a P8-3/P8-4 follow-up.
- Entries are quoted into prompts by P8-2 as untrusted text; chat-template tokens
  (`<|im_start|>`, `[INST]`, …) are not refused at storage (security L2). The `line` rules keep
  them visible; the untrusted-text wrapping is the control.
