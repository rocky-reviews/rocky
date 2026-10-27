# The analysis document

Plain-English summary of what Rocky's AI produces for one PR revision, written for the H2
review gate. The source of truth is the Zod code in `packages/schema/src`; the emitted JSON
Schema is `packages/schema/json-schema/analysis-document.schema.json`; the worked example is
`packages/schema/fixtures/pr-847.json` (the invite PR from the design POC).

Reading time: about 15 minutes.

## In one paragraph (for a non-specialist)

When a pull request arrives, Rocky's AI reads it and writes down what it found as one
structured file: a short briefing, a score, a time estimate and a few notes for every changed
file, a list of draft comments with suggested fixes, and a diagram of what the change touches
(when the diagram fails, the rest still ships and the file says why it is missing). Before Rocky
keeps or shows any of that, a checker goes through the file with a fixed rulebook: every
field has the right type and a size limit; the text cannot hide or spoof characters (no
control, hidden or direction-changing characters; the few joiners emoji and some scripts need
are only allowed where such text uses them); every file and line it mentions really is in the pull
request's diff; its scores, levels and verdict agree with each other; and the facts about the
pull request (commits, files, line counts) come from git, never from the AI. If the file
breaks a rule, Rocky tells the AI exactly which rule and where, lets it try once more, and
otherwise shows "AI couldn't analyse this" instead of a guess. Nothing the AI writes is ever
posted to GitHub without a person accepting it.

## Why one document

Everything the AI contributes to a review (sidebar scores, briefing, change map, flags under
hunks, draft findings, "send to agent" prompts) and everything Rocky does with AI output
(store, render, post after a human accepts) goes through **one validated JSON document per PR
revision**. The model never writes free text that the UI shows directly, and nothing reads
raw model output (ADR 0004).

What is **not** in the document: the PR's title, author, URL, approvals and comments, and the
diff's line content. Those come from Rocky's mirror of GitHub (the source of truth) and the UI
reads them from there; the document carries the AI's analysis and the facts it is checked
against. ADR 0004 says the same.

A document that passes `parseAnalysisDocument` is safe to store and show. One that does not is
sent back to the model once with the exact errors; if it still fails, the file (or the whole
PR) is marked "AI couldn't analyse this" instead of showing anything the model said.

## What the document contains

| Section         | Written by          | What it holds                                                                                                                                                                                                                                                      |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion` | **Rocky**           | `"1.1.0"`. Patch and minor versions add optional fields; a reader accepts its own and older minors of its major; a major may remove fields.                                                                                                                        |
| `provenance`    | **Rocky, from git** | Repo owner/name, PR number, base and head SHAs (full), the list of changed files with additions, deletions and hunk ranges, the files the pipeline could not analyse (with a reason), why the change map is missing (when it is), timestamp, which model did what. |
| `briefing`      | model               | Summary paragraph, risk verdict (level + reason), estimated review minutes for the PR, suggested review path (files + why), "checked, looks fine" list, memory used.                                                                                               |
| `triage`        | model               | Per changed file: score 0–100, level, estimated review minutes, reason, what changed, why this level, flags under specific lines (`look` / `question` / `ok`). Noise files + summary.                                                                              |
| `findings`      | model               | Draft comments: severity, confidence, file + line range, title, markdown body, optional suggested replacement lines, memory references, agent prompt.                                                                                                              |
| `graph`         | model (optional)    | The change map: lanes, nodes, edges, flows with message sequences and payload samples, drill-down views, a 2–12 step walkthrough. Absent when the graph role failed; `provenance.graphUnavailable` then says why.                                                  |

The `provenance` section is the **known facts**. `applyKnownFields(modelOutput, facts)` writes
it over whatever the model returned, so a model can never state a SHA, a file list, a line
count or a hunk range. Every other section is then checked against those facts.

## Annotated excerpt from pr-847

```jsonc
{
  "schemaVersion": "1.1.0",
  "provenance": {
    // From git, never from the model. The only files the rest of the document may name.
    "repo": { "owner": "acme", "name": "rocky-app" },
    "pullRequest": { "number": 847 },
    "base": { "sha": "3f2c9a7d…", "ref": "main" },
    "head": { "sha": "9b4e1d7a…", "ref": "feat/team-invites" },
    "files": [
      {
        "path": "src/auth/invitations.ts",
        "status": "added",
        "additions": 33,
        "deletions": 0,
        // Unified-diff hunk header numbers. Findings and flags must point inside one hunk.
        "hunks": [{ "oldStart": 0, "oldLines": 0, "newStart": 1, "newLines": 33 }]
      }
      // … 8 more files, including pnpm-lock.yaml and a generated types file
    ],
    // Only when the pipeline could not produce a change map (the document then has no `graph`):
    // "graphUnavailable": { "reason": "analysis-failed", "detail": "<fixed pipeline text>" }
    "generatedAt": "2026-10-25T12:00:00.000Z",
    "generator": { "name": "rocky", "roles": [{ "role": "review", "model": "…" }] }
  },
  "briefing": {
    "summary": "Adds **email invitations to orgs**. An admin creates an invite, …",
    // F1 below is critical, so the verdict must be critical (VERDICT_TOO_LOW otherwise).
    "verdict": { "level": "critical", "reason": "This PR adds a **new way to gain membership** …" },
    // At least the sum of the files' reviewMinutes (REVIEW_MINUTES_TOO_LOW otherwise).
    "estimatedReviewMinutes": 7,
    // Each step names a triaged file (never a noise file), each file at most once.
    "reviewPath": [{ "path": "src/auth/invitations.ts", "why": "New path that grants org membership …" }],
    "checkedOk": ["Tenant RLS policy on the new table", "…"],
    "memoryApplied": [{ "entryId": "mem-612", "text": "Secrets and tokens are stored hashed", "source": "PR #612" }]
  },
  "triage": {
    "files": [
      {
        "path": "src/auth/invitations.ts",
        "score": 97, // must sit in the band for its level: critical is 80–100
        "level": "critical",
        "reviewMinutes": 3, // the sidebar's "minutes of high-risk code left" adds these up
        "reason": "New path that grants org membership and sets the member's role.",
        "whatChanged": "New createInvitation() and acceptInvitation(). …",
        "whyThisLevel": "New path that grants org membership …",
        "flags": [
          // A note under line 27. `kind` is look / question / ok. The range must be inside a hunk.
          { "range": { "start": 27, "end": 27 }, "kind": "question", "text": "The invite's email is never compared with `user.email` …" }
        ]
      }
      // … 6 more triaged files
    ],
    // Files the reviewer can trust unread. Triaged + noise must cover every PR file exactly once.
    "noise": [{ "path": "pnpm-lock.yaml", "summary": "One patch bump, `zod 4.6.5 → 4.6.6`. …" }]
  },
  "findings": [
    {
      "id": "F1",
      "severity": "critical", // critical / high / medium / low
      "confidence": 94,
      "path": "src/auth/invitations.ts", // a triaged (non-noise) PR file
      "range": { "start": 28, "end": 28 }, // new-side lines, inside one hunk
      "title": "Invitee can choose their own role, e.g. admin",
      "body": "`requestedRole` comes straight from `req.body.role` and overrides …", // markdown subset
      "suggestion": {
        // Replaces lines 28–28. `context` is line 27, checked against the file when its content is known.
        "lines": ["    role: invite.role,"],
        "context": "    userId: user.id,"
      },
      "memory": [],
      "agentPrompt": "In src/auth/invitations.ts, remove the requestedRole parameter …"
    }
    // … 9 more findings
  ],
  "graph": {
    "lanes": [{ "id": "web", "label": "WEB", "order": 0 } /* API, DATA, WORKERS */],
    "nodes": [
      { "id": "auth", "label": "acceptInvitation()", "kind": "function", "delta": "added", "lane": "api",
        "files": [{ "path": "src/auth/invitations.ts", "range": { "start": 19, "end": 33 } }] }
      // "mem" (memberships) is "unchanged": context the reader needs, pointing at a file outside the PR
    ],
    "edges": [{ "id": "auth-mem", "from": "auth", "to": "mem", "kind": "data", "delta": "added", "label": "grant role", "emphasis": "hero", "animated": true }],
    "flows": [{ "id": "accept-invite", "participants": [{ "node": "page" }, …], "messages": [{ "id": "m1", "from": "page", "to": "route", "label": "POST /invitations/:token/accept", "payload": { "request": { "type": "AcceptBody", "sample": { "role": "admin" } } } }] }],
    "views": [{ "id": "overview", "title": "Everything the PR touches", "scope": { "kind": "all" }, "children": [/* "auth-path": a selection of nodes, edges and the flow */] }],
    "walkthrough": { "steps": [{ "id": "s1", "heading": "A new way in", "body": "An invite link lands on InvitePage …", "focus": { "kind": "selection", "nodes": ["page", "route"], "edges": ["page-route"] } } /* 2 more */] }
  }
}
```

## The rules every document must satisfy

### Shape (Zod, reported as `INVALID_SHAPE` with the JSON path)

- **Strict objects everywhere.** Any field not in the schema is rejected, at every level.
- **Ids** match `^[A-Za-z0-9][A-Za-z0-9._:/-]*$`, at most 128 characters. They survive SVG ids,
  URL fragments and comment anchors without escaping.
- **Paths** are repository-relative POSIX: no leading `/`, no drive letter, no backslash, no
  `.` or `..` segment, no empty segment, no trailing slash, at most 1 024 characters, with no
  control, invisible or line-separator characters and no runs of combining marks. A segment is
  also refused when, after Unicode compatibility folding, removing combining marks and decoding
  percent-encoded dots (`%2e`, `%252e`, overlong `%c0%ae`), it consists only of dots or the dot
  look-alikes U+2024–2026, U+3002, U+FF0E, U+FF61, U+06D4, U+0701, U+0702, U+FE52, U+0589
  (`．．`, `‥`, `…`, `۔۔`, `܁܁`, `.̸`); when it is only whitespace; or when it spells the `.git`
  directory in any form a filesystem may map onto it: `.git`, `.git.`, `.git ` (Windows
  trailing dot/space), `.git:stream` (NTFS alternate data streams), `git~1` (8.3 short names).
  Other punctuation-only names (`!`, `@`, `#`, `'`, `·`) and `.gitignore`, `.github`,
  `.git-hooks` are ordinary files. The same type is used for graph file references. This
  holds for the file list from git too: a PR that adds a file with a newline, a backslash or a
  hidden character in its name cannot be analysed (fail closed).
- **Normalisation.** Paths are not required to be in NFC: git reports what the filesystem has,
  and macOS repositories legitimately carry NFD names. Instead, a PR whose file list has two
  paths equal under NFC is refused (`DUPLICATE_PATH`), and every model-written path must equal
  a listed path byte for byte (`UNKNOWN_FILE` otherwise).
- **Text cannot hide, reorder or smuggle characters.** The rules come from Unicode properties,
  not hand lists. Every text field rejects control characters (C0 and C1), lone surrogates and
  every _default-ignorable_ or _format_ character — soft hyphen, zero-width and bidi controls
  (Trojan Source), word joiners, Hangul fillers, variation selectors, interlinear annotation
  marks and the TAG block used for ASCII smuggling — plus the braille blank. Ordinary prose and
  single-line fields keep four of them that real text needs, under placement rules that leave
  no room for hidden bits: the zero-width joiner and non-joiner only between a visible character
  and a following visible non-mark character (never two in a row), the emoji variation selectors
  VS15/VS16 only directly after an emoji or symbol, and at most 32 of them per string and one
  per two visible characters. Runs of combining marks are capped (6 in single-line fields,
  paths and ids, which still fits Hebrew with vowel points and cantillation; 8 in prose),
  counted across interleaved joiners. Single-line fields (labels, titles) also reject tab,
  newline and the line/paragraph separators. The **agent prompt** is the strictest field: no
  invisible character of any kind, so what the reviewer reads is exactly what the coding agent
  receives. Code lines (suggestions) allow tab, may be empty, and reject every invisible
  character. Payload samples are checked recursively, keys included, and may not use the keys
  `__proto__`, `constructor` or `prototype`.
- **A change map is present or explained, never both.** `graph` is optional. When the pipeline
  could not produce one it records `provenance.graphUnavailable` (`reason`: `analysis-failed`,
  `too-large` or `timeout`, plus an optional `detail`), which the UI shows as "Change map
  unavailable" with the reason and a Retry button. `detail` holds only fixed strings the
  pipeline writes itself, never a raw error message, a prompt or model output. The field lives
  in the facts, like `unanalysed`: `applyKnownFields` overwrites it and, when it is set, drops
  any `graph` the model returned, so a model can neither write the text the UI shows, claim a
  graph failed, nor turn a failed graph into a failed review. A document that reaches the parser
  with both a `graph` and this field is refused. The parser itself is all-or-nothing: a graph
  that still fails validation after the repair round fails the document, with every issue under
  `graph.…`. The pipeline (P4) then strips the graph, sets `graphUnavailable` to
  `analysis-failed` and parses again; the rest of the review ships.
- **The whole document is capped** at 4 MiB of JSON (`MAX_DOCUMENT_BYTES`), checked on the raw
  text by `parseAnalysisDocumentJson` before anything is parsed; input may nest at most 64
  levels (`TOO_DEEP`) and every object may appear once — a cycle or a shared subtree is
  `SHARED_REFERENCE`, which tells the caller the input was not `JSON.parse` output. Flags are
  capped at 2 000 across the document.
- **Every string has a maximum length and every array a maximum size.** They live in
  `packages/schema/src/limits.ts` with the reason for each. The main ones:

| Limit                                  | Value                      |
| -------------------------------------- | -------------------------- |
| Files in a PR                          | 1 000                      |
| Findings                               | 200                        |
| Flags per file                         | 50                         |
| Finding/flag range                     | at most 200 lines          |
| Suggestion replacement lines           | 100 lines × 500 chars      |
| Finding title / body                   | 200 / 4 000 chars          |
| Triage reason, what changed, why       | 500 chars each             |
| Agent prompt                           | 2 000 chars                |
| Briefing summary                       | 2 000 chars                |
| Review path / checked-ok / memory used | 50 / 30 / 50 items         |
| Estimated review minutes (PR)          | 1–480                      |
| Estimated review minutes (per file)    | 0–480                      |
| Lanes / nodes / edges / flows          | 16 / 256 / 512 / 16        |
| Messages per flow, participants        | 64, 2–12                   |
| Payload sample                         | 4 096 bytes, 8 levels deep |
| Views in the tree / depth              | 64 / 4                     |
| Walkthrough steps                      | 2–12                       |

### Integrity (beyond types; each has a code and a JSON path)

| Code                                               | Guarantee                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DUPLICATE_ID`                                     | Ids are unique per collection, compared case-insensitively (lanes, nodes, edges, flows, messages per flow, views across the tree, steps, findings, memory refs).                                                                                                                                |
| `DUPLICATE_PATH`                                   | A path appears once per collection (PR files, unanalysed, triaged files, noise, review path); no two PR files are equal under NFC.                                                                                                                                                              |
| `BROKEN_REFERENCE`                                 | Nodes name declared lanes; edges and flow participants name declared nodes; messages name participants of their flow; view scopes, walkthrough stages and focus name existing elements; focused messages belong to a flow drawn on the step's stage.                                            |
| `UNKNOWN_FILE`                                     | Triage entries, noise entries and findings name files in the PR's file list; review-path steps name triaged files.                                                                                                                                                                              |
| `TRIAGE_COVERAGE`                                  | Every PR file is triaged, noise or (per the facts) unanalysed, exactly once.                                                                                                                                                                                                                    |
| `FINDING_IN_NOISE_FILE`                            | No finding sits in a file triage calls noise.                                                                                                                                                                                                                                                   |
| `FINDING_IN_UNANALYSED_FILE`                       | No finding sits in a file the pipeline lists as unanalysed (`provenance.unanalysed`, written by the overlay, never by the model); such files carry no triage entry, flag or review-path step either.                                                                                            |
| `MEMORY_REF_MISMATCH`                              | Every memory entry a finding cites appears in `briefing.memoryApplied` with identical id, text and source.                                                                                                                                                                                      |
| `LINE_OUTSIDE_DIFF`                                | Finding and flag ranges sit inside **one** new-side hunk (context lines included) of that file's diff.                                                                                                                                                                                          |
| `SCORE_LEVEL_MISMATCH`                             | Scores match their level: critical 80–100, important 50–79, normal 20–49, low 0–19.                                                                                                                                                                                                             |
| `SEVERITY_LEVEL_MISMATCH`                          | A critical or high finding cannot sit in a file triaged `low` ("don't matter" in the sidebar).                                                                                                                                                                                                  |
| `VERDICT_TOO_LOW`                                  | With a critical finding the verdict is `critical`; with a high finding at least `medium`. Only severity counts: the document has no accept/dismiss state (those are the human's, outside the document).                                                                                         |
| `REVIEW_MINUTES_TOO_LOW`                           | `briefing.estimatedReviewMinutes` is at least the sum of `triage.files[].reviewMinutes`. It may exceed it: the briefing and the noise summaries take time too.                                                                                                                                  |
| `SUGGESTION_CONTEXT_IMPOSSIBLE`                    | A suggestion with a context line cannot start at line 1.                                                                                                                                                                                                                                        |
| `SUGGESTION_CONTEXT_MISMATCH`                      | With the file's content available, the context line equals the line before the range.                                                                                                                                                                                                           |
| `SUGGESTION_RANGE_OUTSIDE_FILE`                    | With content available, the range exists in the file.                                                                                                                                                                                                                                           |
| `SUGGESTION_NOOP`                                  | With content available, the replacement differs from the original lines.                                                                                                                                                                                                                        |
| `LIMIT_EXCEEDED`                                   | The view tree holds at most 64 views and nests at most 4 deep; at most 2 000 flags; the JSON text is at most 4 MiB (totals the shape cannot bound).                                                                                                                                             |
| `UNSUPPORTED_SCHEMA_VERSION`                       | Only `1.0.x` is read.                                                                                                                                                                                                                                                                           |
| `INVALID_JSON`                                     | `parseAnalysisDocumentJson` was given text that is not JSON.                                                                                                                                                                                                                                    |
| `TOO_DEEP` / `SHARED_REFERENCE` / `INTERNAL_ERROR` | The parser never throws; input nested over 64 levels is `TOO_DEEP`; any object reached twice (a cycle or a shared subtree, i.e. not `JSON.parse` output) is `SHARED_REFERENCE`, both with the path and found in one linear pass; an unexpected error is `INTERNAL_ERROR` without echoing input. |

**What suggestions can and cannot be checked without file contents.** The hunk ranges in the
facts tell us a range is in the diff, and that a context line at line 1 is impossible. Whether
the replacement makes sense, whether the context line is right, and whether the range exists in
the head file can only be checked when the pipeline passes the new-side file content
(`parseAnalysisDocument(doc, { newFileLines })`). The pipeline (P4-3) has the head blobs and
should always pass them for files that carry suggestions; the document itself never embeds
file contents.

**Input contract.** The pipeline must hand model responses and stored blobs to
`parseAnalysisDocumentJson` as text: it is the only entry point with the byte cap, and
`parseAnalysisDocument` (JSON-parsed data) has none. A leading BOM is tolerated; duplicate JSON
keys follow `JSON.parse` (last one wins), which is safe because only the returned, validated
value is ever stored. Input must be the output of `JSON.parse`: a document assembled in code
that reuses one object in two places is refused as `SHARED_REFERENCE` (serialise and re-parse
it first).

**Design notes on small rules.** Self-loop edges are allowed (a module that calls itself is a
real thing to draw). A node's `group` is a free label, not a reference: groups have no
registry to point at. Ids are compared case-insensitively because anchors often are.

## Schema 1.1 (P4-4, ADR 0015)

- **Version policy:** the reader accepts `1.0.x` and `1.1.x` (`SUPPORTED_VERSION_PATTERN`
  `^1\.(0|1)\.\d+$`); a newer minor is still refused.
- **`provenance.briefingUnavailable`** (optional, `{ reason }`: `analysis-failed`, `timeout`,
  `too-large`): the AI briefing failed after its repair round and the pipeline wrote a fixed one:
  a fixed summary and reason, the verdict at Rocky's deterministic floor, the review path in
  triage order, nothing in `checkedOk`. Pipeline-owned, like `graphUnavailable`.
- **`provenance.readByHand`** (array, default empty, `{ path }`): risky files (migration or auth
  path, or triaged critical) that the AI reviewed and drafted no finding for. The UI says "AI
  found nothing; read by hand". Each entry must be a triaged file of the PR with no finding
  (`READ_BY_HAND_MISMATCH`), and paths are unique (`DUPLICATE_PATH`).
- **No links or images in model text:** prose, single-line text and agent prompts may not hold a
  markdown image, a link to an absolute or protocol-relative URL, an autolink or a link
  definition (`INVALID_SHAPE`). An image loads on sight, so a steered model could exfiltrate
  through one; a link can phish. Relative links, bracketed words and call-like code stay; code
  lines (suggestions) are code and keep everything. This tightens 1.0 text rules; no producer had
  stored analyses outside tests (decision 1 and 7 below still hold for raw HTML).

## How this is tested

- 300+ unit tests, one per rule, each asserting the code **and** the JSON path; both review
  rounds' probe inputs (bidi, default-ignorable and blank-looking characters, ASCII smuggling
  via TAG characters, zalgo, look-alike dot paths, `.git` spellings, `__proto__` keys, a file
  named `constructor`, cyclic and shared input, 100 000-deep input, an 80 MB document, a model
  declaring the critical file unanalysed, a model writing the change-map reason itself) are
  regression tests in `hardening.test.ts` and `known-fields.test.ts`.
- Property tests (fast-check, fixed seed): 150 random valid documents (with noise, unanalysed
  files, memory references, graphs or a pipeline reason for their absence, flows and
  walkthroughs) are accepted and re-parse to themselves; 600 random mutations from 51 mutators
  (unknown fields, control and Unicode hiding characters in text, code and paths, path
  traversal and look-alikes, oversized strings and arrays, duplicate ids incl. case-only,
  duplicate paths, broken references, lines outside the diff, files outside the PR, missing or
  doubled triage, findings in noise or unanalysed files, score, verdict, review-minute and
  memory inconsistencies, a graph next to a "graph unavailable" reason, bad suggestions,
  out-of-order hunks, -0) are each rejected with the expected code at the expected path.
- Golden fixtures `pr-847.json`, `tiny.json`, `large-60-files.json` validate and are stored in
  canonical form; the large one is regenerated by a deterministic script and compared.
- The emitted JSON Schema is byte-identical across runs and matches the committed file.
- Known-fields tests: forged SHAs, repo, PR number, stats, hunks and timestamps are overwritten;
  files the model adds are rejected (`UNKNOWN_FILE`), files it drops fail coverage, widened
  hunks do not legitimise lines outside the diff.

## Decisions (gate H2)

The open questions from the first draft, with the decision taken at the H2 gate and why. The
schema version stayed `1.0.0` at H2: no producer had consumed the contract yet, and H2 was the
gate that fixed it. P4-4 moved it to `1.1.0` (above).

NFD handling (above) was never a question: the facts keep git's spelling, collisions under NFC
are refused, and model paths must match exactly.

1. **Markdown bodies may contain `<`.** Decision: no HTML blocklist in the schema. Reason: the
   UI renders model text with raw HTML disabled (P6), and a blocklist would reject real code
   like `Array<string>`.
2. **Graph is optional.** Decision: it stays optional. A missing or invalid graph never blocks
   the review: the parser rejects a document whose graph is invalid, and the pipeline then
   strips the graph, records why in `provenance.graphUnavailable` and keeps the rest; the UI
   shows "Change map unavailable", the reason and a Retry button. Reason: the change map is a
   reading aid; the triage, briefing and findings are the review.
3. **Noise files are a separate record.** Decision: they stay a separate list, without a score.
   Reason: a noise file is one the reviewer can trust unread; a score would invite reading it.
4. **Score bands.** Decision: they stay: critical 80–100, important 50–79, normal 20–49, low
   0–19. Reason: the POC's numbers fit, and the sidebar sorts by level and shows the score.
5. **Verdict floor.** Decision: a critical finding forces a `critical` verdict (a high finding
   still needs at least `medium`). Reason: a PR with a critical finding is a critical PR; a
   softer verdict would hide it from the reviewer.
6. **Graph file references are not restricted to PR files.** Decision: unchanged context nodes
   stay and cannot be clicked. Reason: they show blast radius; there is no diff to open.
7. **Markdown bodies are not HTML-filtered here.** Decision: same as 1. No blocklist. Reason:
   the UI disables raw HTML, which catches everything a blocklist would and more.
8. **PR title, author and URL are not in the document.** Decision: they stay out. They come
   from Rocky's mirror of the forge. Reason: GitHub is the source of truth, and the title is
   untrusted PR content the model must not launder.
9. **Per-file review minutes.** Decision: every triaged file carries `reviewMinutes` (0–480),
   and the PR estimate must be at least their sum (`REVIEW_MINUTES_TOO_LOW`). Reason: the
   sidebar's "minutes of high-risk code left" needs a per-file number from the analysis, not
   additions ÷ 14, and it must agree with the briefing. The PR estimate may exceed the sum
   because the briefing and the noise summaries take time too; an exact equality would send
   every arithmetic slip through a repair round.
10. **The POC's PR header says +214** while its per-file numbers add up to 215. Decision: the
    fixture keeps the per-file numbers; totals are derived, never stored. Reason: one source
    for every number.
11. **Model-facing schema.** Decision: deferred to Phase 4 (P4-2). The emitted JSON Schema
    stays the full document; Phase 4 may send the model `AnalysisModelOutput` and may need a
    variant without `pattern`/`maxLength`. Reason: it depends on which providers' structured
    output modes accept which keywords, which is only known when the adapters are built.
