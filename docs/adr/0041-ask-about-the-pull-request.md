# ADR 0041: Ask about the pull request

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-07
- **Task:** P9-2
- **Builds on:** [ADR 0040](0040-repository-index-and-embedding-spaces.md) (the index, spaces,
  no stored code), [ADR 0034](0034-pull-request-diff-endpoint.md) (code read from GitHub at
  request time on a short-lived read-only token), [ADR 0012](0012-llm-roles-and-provider-port.md)
  (the `ask` and `embed` roles), [ADR 0015](0015-prompt-injection-defence.md) (untrusted input,
  the leak guard), [ADR 0016](0016-llm-metering.md) (metering), [ADR 0025](0025-security-headers-and-rate-limits.md)
  (the `ask` limit)

## Context

P9-1 built a per-tenant index of each repository's default branch: chunk locations and vectors,
no code. P9-2 lets a reviewer ask a question about the pull request they are reviewing and get
an answer that points at the code it rests on, as links the reviewer can open. The criterion is
that eval questions are answered with valid citations at least 90% of the time. A citation a
reviewer clicks must never point somewhere the model did not actually read.

## Decision

### 1. The flow, and where it lives

`answerQuestion` in `packages/core/src/ask.ts` is the whole flow over ports: embed the question
(and the selected code, if any) with the embed role, search the index, read the hits' lines, ask
the `ask` role, check the citations. The server (`apps/server/src/ask/routes.ts`) supplies the
ports; the eval suite supplies in-memory ones (`packages/evals/src/ask`, §8), so the eval
exercises the production code path and its citation check, not a copy.

`GET /api/repos/:owner/:repo/pulls/:number/ask` says where the index stands (`ready` with the
indexed commit and whether a newer run is under way, `indexing`, `not_indexed`, `off`).
`POST` takes `{ question, selection? }` and answers `answered` or `no_answer`, or a fixed error
code. Both use the `ask` policy (a member who can review) and the same access check as the PR
page (P3-6): an unknown PR, a disabled repository, another org's or one the member cannot read on
GitHub is the same 404. Questions are at most 2 000 characters, selections 4 000, without control
characters; the body limit is 32 KiB and unknown fields are refused.

### 2. Retrieval: the index's space, inside `withOrg`

The question is embedded with the configured embed role and must come back in the index's
space (`isSameSpace`, and the vector's width); a mismatch is `503`, never a cross-space search.
`searchCodeChunks` runs inside `withOrg` for the PR's repository and space, `k = 8`. An index that
is still building its first generation, or one in another model, is `409 indexing` /
`not_indexed`: there is nothing safe to search yet.

### 3. Excerpts are read from GitHub at answer time

The index holds no code (ADR 0040 §5), so the lines the model is shown are read when the
question is asked, the way the diff is (ADR 0034): `forge.openCode` mints an installation token
for that one repository with `contents: read` only; each distinct blob is read once by its id
(exact, whatever the branch did since), decoded as strict UTF-8 and cut to the hit's lines; the
session is closed, and the token revoked, in `finally`. When the index is not settled at its
commit (a run is under way or failed part-way), the commit's tree is read first and a hit whose
path does not hold that blob at the indexed commit is dropped, so an excerpt is always the file
at the indexed head, which is where its link points. Whether it is settled is read again in the
search's own transaction, after the search: a push can start a run while the question is being
embedded, and a run is marked queued or running before it writes a chunk, so a search that
returned a newer blob's chunk always leads to the tree check. Code is never logged, stored or
cached.

Each excerpt is shown as `path`, `lines: a-b`, then numbered lines, cut at 6 000 characters of
code (the index's chunk size; the `N| ` prefixes are not counted, so a whole chunk fits; lines
over 500 characters are cut and marked). The answer's output is capped at 6 000 tokens, thinking
included: enough for a 4 000-character answer and eight citations. The range actually shown is recorded per
excerpt.

### 4. A citation is valid only inside what the model was shown

The answer is schema-validated JSON (`ASK_OUTPUT`: `answered`, `answer` under the schema's prose
rule, at most 8 `citations` of `{ path, start, end }`). `checkCitations` keeps a citation only
when its path is an excerpt's path and its range lies inside the lines shown from that excerpt;
every other citation is dropped and counted before the answer leaves core. There is no repair
round for a bad citation: dropping it is enough, and asking again would spend tokens on a model
that already pointed elsewhere. An answer left with no valid citation is not served as an answer
(`no_answer: uncited`): an uncited claim about code is what Ask exists to avoid.

The page builds each link itself from checked parts: `https://github.com/{owner}/{repo}/blob/{indexed sha}/{path}#La-Lb`,
with the commit a full hex id, each path segment percent-encoded, and no empty, `.` or `..`
segment, control or format character or backslash; a citation it cannot build is dropped, and
an answer left without one is shown as "no good answer". Links open the file at the **indexed
commit on GitHub** in a new tab (`noopener noreferrer`), not the in-app diff: the index is of the
default branch, not the PR head, so the cited lines are often not in the diff at all, and the
commit pins exactly the text the model read.

### 5. Untrusted input, no side effects, no content in logs

The question, the selection (typed or selected by the reviewer, but possibly pasted from the PR),
the paths and the code all travel as `untrusted` parts under Rocky's labels, never in the
instructions (`ASK_INSTRUCTIONS`, in `PROMPT_TEXTS` so the leak guard and the prompt hash cover
it). The answer goes through `completeWithRepair` (schema, then the leak guard). It is text for
the reviewer to read: nothing acts on it, nothing is stored, and nothing posts. Logs carry ids,
counts, codes and token numbers only (`ask_route`, `ask_usage`), never a question, code, prompt or
answer. The injection corpus run on this channel is P9-3's (§9).

### 6. A disabled repository's index is kept, never served

P9-1 left open whether turning a repository off purges its index. **It does not.** A disabled
repository's index is never served (`loadAskTarget` reads enabled repositories only, so Ask
answers 404 as the PR page does) and never updated (an index run fails `repository_disabled`).
It is kept so that turning the repository back on does not spend the embedding tokens again,
and it holds no code: chunk locations, blob ids, hashes and vectors (ADR 0040 §5). It is erased
with everything else of the org (the org's cascade; uninstall, [ADR 0009](0009-installation-lifecycle.md)). A member who wants it
gone sooner has the org erasure; a per-repository purge can be added if a customer asks for it.

### 7. Rate limit and metering

The per-member `ask` limit of ADR 0025 (20 per minute) is applied before any work; P9-3 tunes it
and adds a per-org budget. Every call goes through `meterRoles` (ADR 0016) with the PR's org,
repository and pull request ids. The server's database role cannot insert into `llm_usage` (only
the worker can, P4-5's grants), so the server's records go to a log sink (`ask_usage`: role, model,
token counts and ids only) for now; writing them to `llm_usage` (a grant or a worker hand-off)
is P9-3's, with the rest of metering.

### 8. The eval

`packages/evals/src/ask/` (README "Ask"): a synthetic eleven-file repository (four files are
filler that shares the questions' words) indexed with the production chunker, 12 questions (one
with a selection) with the ranges that answer them, and a scorer. Each question is shown 4
excerpts (production: 8), so retrieval has to find the answer.

**What "valid citation" means for the criterion.** A question is answered with valid citations
when the model answered, **every** citation lies inside lines it was shown (§4), and **at least
one** overlaps a range that answers the question (on target). Inside-what-was-shown alone (the
"guard" count) proves the guard and the model's discipline, not that the answer points at the
right code, so it is not enough for the criterion.

The gate is 90% of questions (`ASK_MIN_VALID_RATE`). A live report is held to it on target (the
comparison recomputes it from the counts; a live report cannot claim the weaker gate). The
`--fake` run (CI) is held to it on the guard only: its bag-of-words embedder and a model that
cites the excerpt sharing most words measure the plumbing and the guard, not retrieval or a
model. Once a baseline passed the eval, a report must run it. The live run is a maintainer step
with a token estimate, as the memory eval's.

### 9. Not in this task (P9-3)

The prompt-injection corpus on the ask channel, the tuned rate limit and per-org budget, and
metering into `llm_usage`. Nothing here needs undoing for them: the inputs are already untrusted
parts, the output already has no effect, and the logs already carry no content.

## Consequences

- A reviewer sees only answers whose every link points into code Rocky read at a pinned commit.
  An honest "the code shown does not say" is a first-class answer.
- Each question costs one embedding call, one `ask` call, and one GitHub token with a handful of
  blob reads.
- The answer is about the default branch's code, not the PR head; the selection carries the PR's
  side when the reviewer selects code. Adding the PR's diff as context is a follow-up.
- Chats are not stored: a reload starts over. Storing them would add tenant data with code-derived
  text, which needs its own retention decision.
