# CLI briefing: `pnpm rocky analyze`

`pnpm rocky analyze <owner/repo>#<n>` (P4-8) runs Rocky's analysis pipeline
([ADR 0014](adr/0014-analysis-pipeline.md)) on one real pull request with your own model key
and prints the briefing in the terminal: the verdict, the risk table and the findings. It is how
we judge review quality on real PRs before the UI exists.

It is **read-only**. It reads the pull request and its diff through the GitHub App and posts,
comments and stores nothing. There is no database: every run starts with no previous analysis.

```sh
pnpm -s rocky analyze <owner/repo>#<number> [--max-tokens N] [--dry-run] [--json]
```

`-s` keeps pnpm's own banner out of the output (it matters for `--json`).

## Setup

The command reads `.env` when it exists, or the environment.

- **GitHub:** `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`. The app must be installed on the
  repository. `GITHUB_URL` and `GITHUB_API_URL` are for GitHub Enterprise Server.
- **Model:** the `ROCKY_LLM_*` roles ([ADR 0012](adr/0012-llm-roles-and-provider-port.md),
  `.env.example`) and the key variable they name. With nothing set, every role is on the
  Anthropic API and the key is in `ANTHROPIC_API_KEY`. The key is billed to your account.
  - The key is read through the roles' `SecretSource` when a call is made. It is never printed
    or logged.
  - A missing key fails before anything is read, with the variable's name:
    `ANTHROPIC_API_KEY is not set: it holds the API key for the anthropic provider (named by ROCKY_LLM_ANTHROPIC_API_KEY_ENV)`.
  - Bedrock and Vertex use their platform credential chain.

## What it does

1. Finds the app's installation for the repository. Opens a repository session: an installation
   token minted read-only (`contents: read`, `pull_requests: read`) for that one repository.
2. Reads the pull request (title, base and head) and the diff of that revision, then closes the
   session, which revokes the token.
3. Runs the pipeline: rules pre-triage, triage, review, change map, briefing, validate and
   repair.
4. Validates the whole document against the schema again, then prints it.

The only non-`GET` requests it makes to GitHub mint and revoke its own read-only tokens. The
tests in `apps/worker/src/cli/analyze.test.ts` prove this by recording every request against a
fake GitHub.

## Output

The default output is plain text, with no colour codes:

- the header: repository, PR number, state, title, base and head commits, and the models that
  answered;
- the verdict level and its reason, and a note when the briefing is Rocky's own fallback
  (`briefingUnavailable`, [ADR 0015](adr/0015-prompt-injection-defence.md) §6);
- the summary and the estimated review time;
- the risk table, by triage level (critical, important, normal, low), then noise. Each row has
  the path, score, minutes and reason;
- the findings, grouped by severity. Each has `[id] path:line`, title and confidence, the body,
  and any suggested replacement;
- the review path in order, and what the AI checked and found fine;
- **Read by hand** (`readByHand`): risky files the AI reviewed and drafted nothing for;
- **Not analysed**: each file with its reason;
- whether the change map was drawn;
- token usage per role: provider and model, calls, input, output, cache read, cache write and
  total, against the cap.

`--json` prints the validated analysis document on stdout and the usage on stderr, so
`pnpm -s rocky analyze … --json > doc.json` is the raw document.

**Untrusted text.** The PR title, paths and everything a model wrote can carry ANSI/OSC escape
sequences, carriage returns or bidi controls. They are escaped before printing (`\x1b`,
`‮`), in the text output and in `--json` (as JSON `\u` escapes, the same value). Single-line
fields also escape newlines, so a title cannot forge a line of its own. A reviewer sees that
something was there.

## Spend cap: `--max-tokens`

Every model call goes through a token budget for the run. The default is **500,000 tokens**,
counting input, output, cache reads and cache writes as the provider reports them. That is
enough for a small or medium PR on the default roles, and small enough that a mistake costs
little. The most you can ask for is 50,000,000.

Before each call, the budget adds up:

- the usage reported so far;
- what calls still in flight may use. Files are analysed in parallel, so each call in flight
  holds a reservation;
- the next call's input estimate (characters / 3, plus prompt and output schema) and its
  `maxOutputTokens`.

If the total is over the cap, the call is refused before it reaches the provider. Every later
call is refused too. The run prints nothing of the briefing, prints the usage so far on stderr
and exits with code 3. A call that fails reports no usage, so it gives its reservation back;
the provider may still have billed part of it.

`--dry-run` shows whether a cap is enough before you spend anything.

**Cost** is not printed yet. The price table comes with P4-5; `UsagePricer` in
`apps/worker/src/cli/render.ts` is the seam it plugs into.

## `--dry-run`

`--dry-run` reads the PR the same way, makes **no model call** and needs no model key. It prints:

- the rules pre-triage of every file: noise (lockfile, generated), not analysed (binary, too
  large), or triage, with any floor (migration, auth → important);
- the planned calls per stage, each with an input estimate and output cap. Review calls depend
  on the triage, so they show as a range;
- the certain calls' total and the worst case (every possible call, each with a repair round),
  compared with the cap.

## Exit codes

| Code | Meaning                                                                     |
| ---- | --------------------------------------------------------------------------- |
| 0    | Briefing printed (or the dry-run plan)                                      |
| 1    | Failed: GitHub read, analysis failure code, provider error; usage on stderr |
| 2    | Bad arguments or configuration (the message names the variable)             |
| 3    | Token cap reached; usage so far on stderr                                   |

Errors are fixed codes and fixed text, for example `reading GitHub failed: forge_http_502`,
`analysis failed: diff_truncated` or `analysis stopped: llm_rate_limited (…)`. They never
include a provider body, a token or PR content.

## First live run (needs a human with a key)

The tests use a scripted model and a fake GitHub, so they spend nothing. The first real run,
on one of Rocky's own PRs:

```sh
# .env: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (app installed on rocky-reviews/rocky), ANTHROPIC_API_KEY
pnpm -s rocky analyze rocky-reviews/rocky#16 --dry-run
pnpm -s rocky analyze rocky-reviews/rocky#16
pnpm -s rocky analyze rocky-reviews/rocky#16 --json > rocky-16.json
```

PR #16 (a migration and its test) is small and touches no prompt text. PRs that change Rocky's
own prompt text (`packages/core/src/prompt.ts`, `analysis/instructions.ts`, ADR 0015, the
injection corpus; #19 and #20, for example) quote it in the diff, so expect the leak guard to
mark some of their files unanalysed (ADR 0015 R6).

Things to watch on that run (ADR 0014 R6): every stage schema is accepted by structured
outputs on the provider (a rejected one, such as the graph's recursive view, shows up as
`analysis failed: llm_invalid_request`), and whether `MAX_OUTPUT_TOKENS` and the default cap fit
real answers.
