# ADR 0046: Entitlement checks before AI work and plan-gated writes

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-11-26
- **Task:** C-8 (the checks in the public app; the conformance suite and the self-host
  implementation were the first half of C-8)
- **Builds on:** [ADR 0002](0002-architecture.md) (ports; Cloud as a plugin),
  [ADR 0014](0014-analysis-pipeline.md) (the pipeline and the worker's run),
  [ADR 0016](0016-llm-metering.md) (metering), [ADR 0017](0017-analysis-queue-and-token-limit.md)
  (the queue and the token limit), [ADR 0027](0027-review-drafts.md) (drafts),
  [ADR 0037](0037-learning-and-applying-project-memory.md) (memory learning and use),
  [ADR 0040](0040-repository-index-and-embedding-spaces.md) (the repository index),
  [ADR 0041](0041-ask-about-the-pull-request.md) (Ask)

## Context

`packages/core` defines the `Entitlements` port (`can(org, feature)`, the `review.*` and `ee:*`
features) and `selfHostEntitlements`, which grants every `review.*` feature. Rocky Cloud plugs in
its own implementation backed by billing plans; both pass the shared conformance suite. Until
this change nothing in the app called `can`, so Cloud's implementation could never take effect:
an org whose plan lapsed, hit a cap or had no key would keep getting analyses, answers and
memory at Rocky's expense.

The owner's decision (2026-11-26): the public app checks entitlements before work that costs AI
or is plan-gated; self-hosted instances keep the always-yes default, so nothing changes for
them. Reads of stored results are never gated. The business rules themselves (which plan has
what) stay in the private repo; the public app only asks the port.

## Decision

### 1. One check, fail closed (`checkEntitlement`, `packages/core/src/entitlements.ts`)

Every gated path calls `checkEntitlement(entitlements, orgId, feature)`, which returns a typed
verdict and never throws:

- `{ granted: true }` only when `can` answers exactly `true`;
- `{ granted: false, code: "entitlement_denied", feature, reason }` otherwise: `false` or a
  non-boolean is `denied`; a `can` that throws or rejects is `unavailable` (state that cannot be
  read grants nothing); a feature outside `FEATURES` is `unknown-feature`, refused before the
  implementation is asked.

The port gains an optional `decide(org, feature)` (Rocky Cloud has one, with reasons such as
`no-plan` or `not-in-plan`). It is read only after `can` denied, to tell the person why, and its
reason is kept only when it is a short kebab-case code (`isEntitlementReason`,
`/^[a-z][a-z0-9-]{0,31}$/`); anything else becomes `denied`. `decide` can never grant: `can` is
the authority. `ee:*` features need nothing here: no `ee` code exists yet.

### 2. Where the checks run, and what each gates

| Path                                        | Feature(s)                           | Layer                                  | On denial                                                                                   |
| ------------------------------------------- | ------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| Analysis run (`runAnalysis`)                | `review.triage`, `review.change-map` | worker, at claim time                  | row `failed`, `error_code = entitlement_denied`; no forge read, no model call, no usage row |
| Project memory in the analysis              | `review.memory`                      | worker, same run                       | run goes ahead with no entries loaded, sent or touched                                      |
| Repository index (`runCodeIndex`)           | `review.ask`                         | worker, at claim time                  | run `failed`, `error_code = entitlement_denied`; no token minted, nothing embedded          |
| Ask (`POST …/ask`)                          | `review.ask`                         | server, after the access check         | 403 `entitlement_denied`; no embedding, no model call, no usage row, no org budget spent    |
| Draft decision (`POST …/drafts/:findingId`) | `review.drafts`                      | server, after the access check         | 403 `entitlement_denied`; nothing written                                                   |
| Memory edit (`POST …/entries/:id/edit`)     | `review.memory`                      | server, after the access check         | 403 `entitlement_denied`; nothing written                                                   |
| Learning from a posted review               | `review.memory`                      | server, posting service, after posting | learning skipped (`memory_entitlement_denied` in the log); the review is posted as usual    |

**The analysis needs both of its features, or nothing starts.** The pipeline draws triage,
findings, briefing and change map into one document. Skipping the map alone would need a new
`graphUnavailable.reason` (a schema minor version and renderer work, as `no-logic` was in 1.2),
so a plan with triage and without the map is not expressible today; Rocky Cloud's plans grant
every `review.*` feature together, so nothing is lost. Per-stage skipping is a follow-up for the
day a plan needs it. `review.memory` is different: without it the run simply loads no entries
(`memoryApplied: []` is a valid document), so it is a clean skip, not a stop.

**The worker checks at claim time, not at enqueue time.** The mirror queues analyses and index
runs without asking; a plan can lapse while a row waits, so the check runs when the row is picked
up, before the forge read and before any model call. A denial is stored as `failed` and is not
retried: the plan, not the run, has to change, and the next push (or an explicit re-run) asks
again. There is no retry loop, and `review.memory` is asked once per run.

**The server gates the writes that make or spend something; reads stay open.** Stored reviews,
findings, change maps, draft decisions, Ask's index state, memory lists and exports are history
and are never gated. Switching memory off and deleting entries are not gated either: they shrink
what is stored, cost nothing, and a person must always be able to remove what Rocky learned.
Posting a review is the person's act on GitHub and is never gated; only the learning that follows
it is. A reviewer's own pending comments are their words, not AI drafts.

**The repository index is gated under `review.ask`.** The index exists only to answer Ask (ADR
0040); embedding costs tokens, so an org without Ask does not pay for pushes.

### 3. The answer

Every refusal is one stable shape: the worker stores and logs the code `entitlement_denied`; the
API answers `403 { error: "entitlement_denied", feature, reason }` with `cache-control:
no-store`. `feature` is one of `FEATURES`; `reason` is a fixed code (`denied`, `unavailable`,
`unknown-feature`, or a Cloud reason that passed `isEntitlementReason`). Nothing from the
request, the org's billing state or an error message is in the body or the log line; logs carry
the org and row ids, `errorCode`, `feature` and `reason`. The web app maps the code to a fixed
message that points to the organisation's billing (the briefing's failure text, the Ask panel, a
draft toast, the memory page's problem line) and offers no retry for it.

### 4. Wiring

`buildApp` (`apps/server`) and `startJobs` (`apps/worker`) take `entitlements?: Entitlements`
and default to `selfHostEntitlements({ hasEnterpriseLicence: false })`; `startServer` passes
`options.entitlements` through. Rocky Cloud passes its plan-backed implementation at these two
composition roots. Inside, `runAnalysis`, `runCodeIndex`, the Ask, drafts and memory routes and
the posting service take a required `Entitlements`, so no gated path can be built without one
(`runAnalysis` refuses to start without it, as it does without metering). The `rocky analyze`
CLI calls the pipeline directly for one person's own key and is not gated: there is no org.

## Threat model

**Assets:** the org's AI spend (Cloud's managed keys, or a BYOK key); Cloud's plan enforcement
(a lapsed, capped or keyless org must get no AI work); stored reviews, findings, maps and memory
(must stay readable); tenant isolation (an answer for one org never reflects another's); logs.

**Attackers:** a client that keeps calling after a plan lapsed (the UI is never trusted: the
server and the worker check); a queued job that outlives the plan (the worker re-checks when it
claims the row); a broken, slow or lying entitlements backend (a throw is a denial; `decide`
cannot grant); a reason string that carries data (allowlisted shape only); PR content (never
reaches the check, which runs on ids and a feature literal).

| What can go wrong                                  | Prevented by                                                                   | Tested by                                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| AI work for an org whose plan lapsed               | the check before the forge read and before any model call, in every gated path | a denying `Entitlements` on each path: no model call, no forge read, no usage row, the stable code (worker and server e2e tests) |
| A job queued before the lapse still runs           | the check at claim time                                                        | `a row queued while entitled is re-checked when the worker claims it`                                                            |
| A broken backend grants by accident                | `can` must answer exactly `true`; throw, reject, non-boolean are denials       | core unit tests; `fails closed` tests on the analysis, index, Ask, drafts, memory and learning paths                             |
| `decide` grants what `can` refused                 | `decide` is read only after a denial, for the reason                           | `a decide that throws, rejects or contradicts can leaves the denial in place`                                                    |
| A reason leaks billing data or injects into the UI | `isEntitlementReason` allowlist, else `denied`                                 | `never leaks an unsafe reason`                                                                                                   |
| A denial becomes a retry loop                      | stored as `failed`, never requeued; `review.memory` asked once                 | the analysis and index tests assert `failed`, not `retry`                                                                        |
| Reads break for a lapsed org                       | no check on GET routes, lists, exports, deletions                              | `reads stay available` assertions in the Ask, drafts and memory tests                                                            |
| Self-hosters lose behaviour                        | `selfHostEntitlements` default at both composition roots                       | every existing suite runs on the default and stays green; the self-host test grants every analysis feature                       |
| An org is judged by another org's plan             | the check takes the row's or session's `orgId` only                            | `only asks about the org it was given`; `asked about the analysis's own org only`                                                |
| Content in logs                                    | log lines carry ids, `errorCode`, `feature`, `reason`                          | marker assertions in every denial test                                                                                           |

## Consequences

- Self-hosted instances see no change: the default grants every `review.*` feature, and the
  check costs one resolved promise per gated call.
- Rocky Cloud's `Entitlements` takes effect once Cloud passes it to `buildApp` and `startJobs`;
  its `decide` reasons reach the person as fixed codes. Shadow mode (Cloud's `can` answering
  `true` while recording what enforcement would do) needs no change here.
- A denied analysis is a `failed` row with a readable explanation; after the plan is fixed the
  next push analyses as usual. Re-running a denied analysis without a push is whatever the
  existing re-run paths offer (follow-up if a "Run again" button is wanted).
- `AnalysisRunnerDeps`, `CodeIndexDeps`, `AskRoutesDeps`, `ReviewRoutesDeps`,
  `MemoryRoutesDeps` and `ReviewPostingDeps` gained a required `entitlements`; every caller in
  the repository passes one.

## Residual risks

- Per-stage skipping (a plan with triage and without the change map) is not expressible without
  a schema minor version; today the run stops instead. Recorded as a follow-up.
- The entitlement is asked once per analysis run; a plan that lapses mid-run finishes that run.
  Bounded by the per-PR token limit (ADR 0017) and Cloud's own spend controls (C-7).
- Memory switches (`PUT …/enabled`, `PUT …/disabled`) and deletes are deliberately not gated;
  re-enabling memory on a lapsed org has no effect until the plan is good again, because the
  analysis asks `review.memory` itself.
