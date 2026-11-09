# ADR 0042: Ask safety: the injection corpus on Ask, limits and metering

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-09
- **Task:** P9-3
- **Builds on:** [ADR 0041](0041-ask-about-the-pull-request.md) (Ask; its §7 and §9 are done
  here), [ADR 0015](0015-prompt-injection-defence.md) (the corpus, the leak guard, the schema's
  text rules), [ADR 0025](0025-security-headers-and-rate-limits.md) (rate limits, the `ask`
  scope), [ADR 0016](0016-llm-metering.md) (metering, `llm_usage`)

## Context

P9-2 built Ask: a reviewer's question, answered by the `ask` role from excerpts of the
repository's indexed code, with citations only into lines the model was shown. Three inputs are
written by people Rocky does not trust: the repository's code (any contributor, shown as
excerpts), the question and the selected code (typed or pasted by the reviewer, possibly from
the PR). P4-4's defences were built for the analysis pipeline; P9-3 must show they hold on this
channel with the same corpus (the acceptance criterion: "injection corpus reused"), bound what a
member or an org can spend through Ask, and record every call in `llm_usage` like analysis does.

## Threat model

**Assets:** the answer a reviewer reads and the links they click; Rocky's prompt text and canary
(integrity of what is served, as in ADR 0015 R3); the tenant's money (model and embedding calls,
GitHub token mints); the ledger `llm_usage` (complete and honest); the index of other tenants;
logs free of code, questions, prompts and answers.

**Attackers:** a repository contributor whose code becomes an excerpt; a PR author whose text a
reviewer pastes into a question or selects; a member (or a stolen session) asking in a loop; a
model steered by any of them; another tenant; a reader of the logs.

| #   | What can go wrong                                                                                    | Prevention                                                                                                                                                                                                                                                  | Test                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | An excerpt, question or selection carries instructions and reaches the system slot or a tool         | Every variable input is an `untrusted` part under Rocky's labels (`question`, `selection`, `code`); instructions are literals in `PROMPT_TEXTS`; no tools on either wire; nonce-delimited parts                                                             | `injection-corpus.test.ts` "ask shape" on both wires; `ask-injection.test.ts` "the trigger never reaches the instructions"                                                           |
| Q2  | A steered model copies the instructions or the canary into the answer                                | `completeWithRepair` runs the leak guard (ADR 0015 §3) on every answer; a leak after repair fails the question (`answer_failed`); the served answer is never the leaking one                                                                                | `ask-injection.test.ts` `leak*` adversaries × corpus × 3 channels; L1 recomputed with `findLeaks`                                                                                    |
| Q3  | A steered model cites code it was not shown (another file, other lines, the question, the selection) | `checkCitations` keeps a citation only inside a shown excerpt's range; an answer with none is `no_answer: uncited`; the page builds links from checked parts only                                                                                           | `outside` adversary × corpus × channels; citations re-checked against the sources independently of core                                                                              |
| Q4  | A steered model emits markup that acts when rendered (image, link, autolink, HTML)                   | The output schema's prose rule refuses images, absolute links, autolinks and link definitions; the panel renders text only (no raw HTML); a refused answer after repair is `answer_failed`                                                                  | `poison` adversary × corpus × channels, markup re-checked with the eval's own patterns                                                                                               |
| Q5  | A steered model answers in a tool-call or extra-field shape that something acts on                   | Strict output schema (`ASK_OUTPUT`); nothing executes model output; the answer is text for the reviewer                                                                                                                                                     | `tool` and `fake` adversaries × corpus × channels → `answer_failed`                                                                                                                  |
| Q6  | A steered model changes the answer's claims (says what the payload asked)                            | Not prevented in the text itself (R1); what holds: every served claim comes with citations into code the model was shown, so the reviewer can check; the live eval measures how often a model echoes the payload's marker                                   | `obey` adversary: served only with valid citations; `--ask --injection` reports `echoed`                                                                                             |
| Q7  | A payload makes the request fail at the door, or silently drops the question                         | `checkAskRequest` refuses control characters and oversize input with a fixed code (400); an honest model still answers a question whose excerpt carries a payload                                                                                           | `ask-injection.test.ts` "the honest model answers every planted case"; refusals counted, never vacuous                                                                               |
| Q8  | One member spends without bound (a loop, a stolen session)                                           | `ask` per member, 10 per minute, consumed before the body is read                                                                                                                                                                                           | `routes.db.test.ts` "limits each member's questions per minute"                                                                                                                      |
| Q9  | An org spends without bound (many members, many sessions, one runaway client)                        | `ask.org` (60 per minute) and `ask.org.day` (600 per day) per org, consumed atomically before anything is read or spent; a 429 names which limit (`member` or `org`) and `Retry-After`; `ROCKY_RATE_LIMIT_ASK_ORG*` overrides, never off                    | `routes.db.test.ts` "the org's budget …": concurrent requests over the limit reach the model exactly `max` times; `rate-limit.test.ts` defaults and env                              |
| Q10 | A model call is made and not metered (the server's role could not write `llm_usage`)                 | Migration 0023: the server may insert `ask` and `embed` rows for its tenant with no analysis link (column-scoped INSERT, a RESTRICTIVE policy); each call writes in its own transaction before its result is used; a failed write fails the question closed | `usage.test.ts` server inserts ask/embed rows, refused for other roles and with an analysis id; `routes.db.test.ts` rows per answer, partial usage on failure, 503 on a failed write |
| Q11 | Usage rows name another tenant's org, repository or pull request                                     | FORCE RLS tenant policy on `llm_usage`; `org_id` defaults to the transaction's tenant and is not in the server's grant; composite foreign keys `(org_id, repo_id)` and `(org_id, pull_request_id)`                                                          | `usage.test.ts` "a repository of another org is refused"; `isolation.test.ts` matrix                                                                                                 |
| Q12 | The ledger is edited or shrunk through the new columns                                               | Append-only trigger kept; the only UPDATE allowed is unlinking (`analysis_id`, `repo_id` or `pull_request_id` to NULL) by a foreign key's `ON DELETE SET NULL`                                                                                              | `usage.test.ts` append-only cases incl. the new columns                                                                                                                              |
| Q13 | A question, code, prompt or answer reaches a log line, a usage row or an eval report                 | Log lines carry ids, counts and fixed codes; usage records hold ids, enums and numbers (checked before SQL); eval reports hold ids, codes and counts                                                                                                        | `routes.db.test.ts` `noContentInLogs` on every path; `usage.test.ts` shape checks; `report.ts` schema                                                                                |
| Q14 | A limit silently off or shared across tenants                                                        | Scopes keyed by member id and org id, HMAC'd; malformed `ROCKY_RATE_LIMIT_*` refuses to boot; store failure answers 503                                                                                                                                     | `rate-limit.test.ts`; `routes.db.test.ts` another org's questions do not spend A's budget                                                                                            |

### Residual risks

- **R1 (claims).** Above the structure, the answer's prose is model text. A steered model can
  say what the payload asked as long as it cites shown code. The reviewer sees the cited lines
  and the links are pinned to the indexed commit; the text itself is a draft to be checked.
  The live eval reports how often a model echoes a payload's marker (`echoed`).
- **R2 (per-instance limits).** As ADR 0025 R1: counters are per server instance and reset on
  restart; the daily org budget is bounded by the process's lifetime. A shared store is the
  follow-up.
- **R3 (budget is in questions, not tokens).** A question's cost is bounded by the excerpt and
  output caps (ADR 0041 §3), so questions bound tokens; a per-token budget would need the count
  after the call (overshoot by what is in flight).
- **R4 (fakes are not models).** The adversaries obey completely; they cannot show how a real
  model is steered. `pnpm evals run --ask --injection` runs the same cases against the configured
  model (a maintainer step, with an estimate in the README).

## Decision

### 1. The defences are P4-4's, unchanged; what P9-3 adds is the proof

Ask already had the structure (ADR 0041 §4–5): the question, the selection, the paths and the
code travel as `untrusted` parts under Rocky's labels; the instructions are literals in
`PROMPT_TEXTS`; the answer goes through `completeWithRepair` (strict schema with the prose text
rule, then the leak guard); `checkCitations` keeps only citations into lines the model was
shown; nothing acts on the answer. No prompt, schema or guard changes here. Two tests make the
structure a checked fact on this channel:

- `packages/llm/src/adapters/injection-corpus.test.ts` ("in Ask's inputs on the wire"): every
  corpus payload in the three Ask-labelled parts through the Anthropic and OpenAI-compatible
  request builders: no tools, Rocky's system text only, one closing marker per part, chat-template
  tokens broken.
- `packages/evals/src/ask-injection.test.ts` (§2).

### 2. The corpus on the Ask channel (`packages/evals/src/ask/injection.ts`)

Every case of the P4-4 corpus is planted in each of Ask's untrusted inputs: `code` (appended to
the first of three fixed excerpts of the Ask eval's repository, as comment lines), `question`
(pasted before the clean question) and `selection` (at the top of the selected code). The flow is
core's `answerQuestion` over in-memory ports with a constant embedder and a search that returns
the fixed excerpts: retrieval is out of the picture and no embedding is spent.

Ten **Ask adversaries** obey a payload completely on every call that carries its trigger (the
pipeline's adversaries, in Ask's one-field shape): `leak`, `leak_filler`, `leak_canary`,
`leak_glyphs` (the prompt or canary in the answer, adapted to the guard's rules), `outside`
(citations to `README.md`, line 9000, the selection and `secrets/.env`), `tool` (tool-call JSON),
`fake` (extra fields), `poison` (an image, links and an autolink; in the repair round HTML and a
shell command as text), `obey` (the trigger as the answer's claim, validly cited) and `sabotage`
(a refusal). The CI test runs 37 × 3 × 10 and asserts, independently of core (the eval's own
`findLeaks`, its own citation and markup checks over the planted sources):

- the trigger reaches the model only in the part of its own channel, never the instructions,
  and only the `ask` role is called;
- nothing served leaks, cites outside what was shown, or carries markup;
- leak, tool, fake and refusal fail closed (`failed`, nothing served), the outside citations are
  dropped (an answer left with none is `no_answer: uncited`; the selection's own lines are also
  lines of the first excerpt, so citing them stands);
- what the structure cannot stop is served and counted: `obey` (R1) and the `poison` repair
  round's HTML and shell command, which the panel renders as text (ADR 0041 §5; Q4);
- an honest model answers the planted question as it answers the clean one.

`pnpm evals run --ask-injection` runs the same 111 questions against the configured model (the
`ask` role only) and reports, per case and in total: the status and its code, `dropped`, and
`leaks`, `outside`, `markup` (each gated at 0 by `compare`) and `echoed` (the served text carried
the trigger: measured, not gated). `--fake` gives each case the adversary for its goal, so the
counts in `baselines/fake.json` are non-zero where they should be and zero where a guard holds.
The live run is a maintainer step with a token estimate (README "Ask injection"); the new test
file is a protected eval path (CODEOWNERS, `evals.yml`).

### 3. Limits (`apps/server/src/security/rate-limit.ts`, ADR 0025 §3 amended)

| Scope         | Key    | Default     | Why                                                                                     |
| ------------- | ------ | ----------- | --------------------------------------------------------------------------------------- |
| `ask`         | member | 10 / 1 min  | A person types a question in more than six seconds; a loop or a stolen session does not |
| `ask.org`     | org    | 60 / 1 min  | A burst across an org's members (six at their own cap)                                  |
| `ask.org.day` | org    | 600 / 1 day | What a day may cost, whatever the number of members or sessions                         |

All three are consumed, in that order, before the body is read, the row loaded or anything
spent; `consume` counts and checks in one step, so concurrent questions cannot overshoot a
budget. The 429 body says which it was (`limit: "member"` or `"org"`) with `Retry-After`, and the
panel shows distinct copy with the wait (seconds for the member's minute; minutes or hours for
the org's budget). Overrides: `ROCKY_RATE_LIMIT_ASK`, `ROCKY_RATE_LIMIT_ASK_ORG`,
`ROCKY_RATE_LIMIT_ASK_ORG_DAY` (`<max>/<seconds>`; a limit cannot be turned off). The budget is
in questions, not tokens: a question's tokens are bounded by the excerpt and output caps (ADR 0041
§3), and a count can be enforced before the call while a token budget could only be charged after
it (R3). The store is per instance (ADR 0025 R1).

### 4. Metering into `llm_usage` (migration 0023, ADR 0016 amended)

The server's login could only read `llm_usage` (0011: the worker made every call). Now:

- **Columns `repo_id` and `pull_request_id`** (nullable, composite foreign keys to `repos` and
  `pull_requests`, `ON DELETE SET NULL`, a pull request never without its repository; an index
  on `(org_id, repo_id)`). Ask stamps both; the index run (P9-1) stamps its repository; analysis
  rows keep `analysis_id`.
- **Append-only kept.** The trigger's one allowed UPDATE is now "unlink": any of the three link
  columns set to NULL and nothing else, which is what a foreign key's `SET NULL` does.
- **The server's grant is column-scoped:** INSERT on every column a row needs except `org_id`
  (the tenant's default; FORCE RLS checks it) and `analysis_id` (the server makes no analysis
  call). The writer (`recordLlmUsage`) therefore names only the columns a batch carries, through
  a parameterised INSERT rather than the query builder, which names every column of the table
  with `DEFAULT` and would defeat a column grant.
- **A RESTRICTIVE policy** lets a login without `rocky_worker` insert only `ask` and `embed` rows
  with no analysis link. The worker's table grant is unchanged.
- **Per call, in its own transaction**, through `meterRoles` with `repoId` and `pullRequestId`:
  a failed model call records its partial usage; the embedding's row stands when GitHub then
  fails; a write that still fails after its retries fails the question closed (503
  `ask_unavailable`, nothing more is called) and the meter logs the record as numbers and ids.
  The `ask_usage` log line of P9-2 is gone.

`packages/db/THREATS.md` points here (Q10–Q13).

### 5. The panel (ADR 0041 §4 amended)

Two error states, `rate_limited` and `org_rate_limited`, with the wait from `Retry-After` when
the source could read it as a plain number of seconds (1 to a day), and "Try again" as for any
error. Screenshots: `apps/web/e2e/__screenshots__/ask-rate-limited-*` and `ask-org-limited-*`
(375/1024/1440 × light/dark); axe in `ask.e2e.spec.ts` and `a11y.e2e.spec.ts` with 0 serious
issues.

## Consequences

- Every corpus change now runs on two channels (the pipeline and Ask) in CI, for free, and on
  Ask against a real model at a maintainer's hand.
- Usage per repository is a query away (`llm_usage.repo_id`), for Ask, the index and later
  analysis rows if P11 wants them.
- An org can run out of Ask for a day; the operator raises `ROCKY_RATE_LIMIT_ASK_ORG_DAY`.
