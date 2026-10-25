# The analysis document

Plain-English summary of what Rocky's AI produces for one PR revision, written for the H2
review gate. The source of truth is the Zod code in `packages/schema/src`; the emitted JSON
Schema is `packages/schema/json-schema/analysis-document.schema.json`; the worked example is
`packages/schema/fixtures/pr-847.json` (the invite PR from the design POC).

Reading time: about 15 minutes.

## Why one document

Everything the reviewer sees (sidebar, briefing, change map, flags under hunks, draft findings,
"send to agent" prompts) and everything Rocky does with AI output (store, render, post after a
human accepts) reads **one validated JSON document per PR revision**. The model never writes
free text that the UI shows directly, and nothing reads raw model output (ADR 0004).

A document that passes `parseAnalysisDocument` is safe to store and show. One that does not is
sent back to the model once with the exact errors; if it still fails, the UI shows "AI couldn't
analyse this" instead of anything the model said.

## What the document contains

| Section         | Written by          | What it holds                                                                                                                                                |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion` | **Rocky**           | `"1.0.0"`. Patch and minor versions only add optional fields; a major may remove fields.                                                                     |
| `provenance`    | **Rocky, from git** | Repo owner/name, PR number, base and head SHAs (full), the list of changed files with additions, deletions and hunk ranges, timestamp, which model did what. |
| `briefing`      | model               | Summary paragraph, risk verdict (level + reason), estimated review minutes, suggested review path (files + why), "checked, looks fine" list, memory used.    |
| `triage`        | model               | Per changed file: score 0–100, level, reason, what changed, why this level, flags under specific lines (`look` / `question` / `ok`). Noise files + summary.  |
| `findings`      | model               | Draft comments: severity, confidence, file + line range, title, markdown body, optional suggested replacement lines, memory references, agent prompt.        |
| `graph`         | model (optional)    | The change map: lanes, nodes, edges, flows with message sequences and payload samples, drill-down views, a 2–12 step walkthrough.                            |

The `provenance` section is the **known facts**. `applyKnownFields(modelOutput, facts)` writes
it over whatever the model returned, so a model can never state a SHA, a file list, a line
count or a hunk range. Every other section is then checked against those facts.

## Annotated excerpt from pr-847

```jsonc
{
  "schemaVersion": "1.0.0",
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
    "generatedAt": "2026-10-25T12:00:00.000Z",
    "generator": { "name": "rocky", "roles": [{ "role": "review", "model": "…" }] }
  },
  "briefing": {
    "summary": "Adds **email invitations to orgs**. An admin creates an invite, …",
    "verdict": { "level": "high", "reason": "This PR adds a **new way to gain membership** …" },
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
  `.` or `..` segment, no empty segment, no trailing slash, no control characters, at most
  1 024 characters. This holds for the file list from git too: a PR that adds a file with a
  newline or backslash in its name cannot be analysed (fail closed).
- **Text** rejects control characters. Single-line fields (labels, titles, paths, ids) reject
  all of them including tab and newline; prose fields (bodies, reasons, summaries) allow only
  `\n` and `\t`; code lines (suggestions) allow tab, may be empty, never contain a newline.
  Payload samples are checked recursively, keys included.
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
| Estimated review minutes               | 1–480                      |
| Lanes / nodes / edges / flows          | 16 / 256 / 512 / 16        |
| Messages per flow, participants        | 64, 2–12                   |
| Payload sample                         | 4 096 bytes, 8 levels deep |
| Views in the tree / depth              | 64 / 4                     |
| Walkthrough steps                      | 2–12                       |

### Integrity (beyond types; each has a code and a JSON path)

| Code                            | Guarantee                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DUPLICATE_ID`                  | Ids are unique per collection (lanes, nodes, edges, flows, messages per flow, views across the tree, steps, findings, memory refs).                                                                                                                  |
| `DUPLICATE_PATH`                | A path appears once per collection (PR files, triaged files, noise, review path).                                                                                                                                                                    |
| `BROKEN_REFERENCE`              | Nodes name declared lanes; edges and flow participants name declared nodes; messages name participants of their flow; view scopes, walkthrough stages and focus name existing elements; focused messages belong to a flow drawn on the step's stage. |
| `UNKNOWN_FILE`                  | Triage entries, noise entries and findings name files in the PR's file list; review-path steps name triaged files.                                                                                                                                   |
| `TRIAGE_COVERAGE`               | Every PR file is triaged or noise, exactly once.                                                                                                                                                                                                     |
| `FINDING_IN_NOISE_FILE`         | No finding sits in a file triage calls noise.                                                                                                                                                                                                        |
| `LINE_OUTSIDE_DIFF`             | Finding and flag ranges sit inside **one** new-side hunk (context lines included) of that file's diff.                                                                                                                                               |
| `SCORE_LEVEL_MISMATCH`          | Scores match their level: critical 80–100, important 50–79, normal 20–49, low 0–19.                                                                                                                                                                  |
| `SEVERITY_LEVEL_MISMATCH`       | A critical or high finding cannot sit in a file triaged `low` ("don't matter" in the sidebar).                                                                                                                                                       |
| `VERDICT_TOO_LOW`               | With a critical finding the verdict is at least `high`; with a high finding at least `medium`.                                                                                                                                                       |
| `SUGGESTION_CONTEXT_IMPOSSIBLE` | A suggestion with a context line cannot start at line 1.                                                                                                                                                                                             |
| `SUGGESTION_CONTEXT_MISMATCH`   | With the file's content available, the context line equals the line before the range.                                                                                                                                                                |
| `SUGGESTION_RANGE_OUTSIDE_FILE` | With content available, the range exists in the file.                                                                                                                                                                                                |
| `SUGGESTION_NOOP`               | With content available, the replacement differs from the original lines.                                                                                                                                                                             |
| `LIMIT_EXCEEDED`                | The view tree holds at most 64 views and nests at most 4 deep (the shape cannot bound a tree's total).                                                                                                                                               |
| `UNSUPPORTED_SCHEMA_VERSION`    | Only `1.0.x` is read.                                                                                                                                                                                                                                |
| `TOO_DEEP` / `INTERNAL_ERROR`   | The parser never throws; a document too deep to walk, or an unexpected error, is reported as such.                                                                                                                                                   |

**What suggestions can and cannot be checked without file contents.** The hunk ranges in the
facts tell us a range is in the diff, and that a context line at line 1 is impossible. Whether
the replacement makes sense, whether the context line is right, and whether the range exists in
the head file can only be checked when the pipeline passes the new-side file content
(`parseAnalysisDocument(doc, { newFileLines })`). The pipeline (P4-3) has the head blobs and
should always pass them for files that carry suggestions; the document itself never embeds
file contents.

## How this is tested

- 170+ unit tests, one per rule, each asserting the code **and** the JSON path.
- Property tests (fast-check, fixed seed): 150 random valid documents are accepted and
  re-parse to themselves; 400 random mutations (unknown fields, control characters, path
  traversal, oversized strings and arrays, duplicate ids, broken references, lines outside the
  diff, files outside the PR, missing or doubled triage, score and verdict inconsistencies,
  bad suggestions) are each rejected with the expected code at the expected path.
- Golden fixtures `pr-847.json`, `tiny.json`, `large-60-files.json` validate and are stored in
  canonical form; the large one is regenerated by a deterministic script and compared.
- The emitted JSON Schema is byte-identical across runs and matches the committed file.
- Known-fields tests: forged SHAs, repo, PR number, stats, hunks and timestamps are overwritten;
  files the model adds are rejected (`UNKNOWN_FILE`), files it drops fail coverage, widened
  hunks do not legitimise lines outside the diff.

## Open questions for the founder

1. **Graph is optional.** If the graph role fails, the rest of the document still ships and the
   UI shows no change map. Should a missing graph instead block the whole analysis?
2. **Noise files are a separate record** (path + summary) rather than a triaged file with
   level `noise`. The UI groups by five levels; the document has four levels plus a noise list.
   Fine, or should noise carry a score too?
3. **Score bands** (80/50/20) are a contract now. The POC's numbers fit; do yours?
4. **Verdict floor** is deliberately mild (critical finding → at least `high`). Should a
   critical finding force a `critical` verdict?
5. **Graph file references are not restricted to PR files** (unchanged context nodes point at
   untouched files). Click-through on such a node (P5-3) has nothing to open; acceptable?
6. **Markdown bodies are not HTML-filtered here.** The schema guarantees bounded size and no
   control characters; the UI must render markdown with no raw HTML (P6). Do you want a
   blocklist (`<script`, `javascript:`) in the schema as well, at the cost of false positives
   on code like `Array<string>`?
7. **PR title, author and URL are not in the document.** They come from the PR mirror in the
   database, and the title is untrusted PR content. OK?
8. **Per-file review minutes.** The POC derives "about N min left" from additions ÷ 14; the
   document carries only a PR-level estimate. Should triage carry a per-file estimate?
9. **The POC's PR header says +214** while its per-file numbers add up to 215. The fixture keeps
   the per-file numbers; totals are derived, never stored.
10. **Model-facing schema.** The emitted JSON Schema is the full document. Phase 4 will likely
    send the model `AnalysisModelOutput` (everything except `provenance` and `schemaVersion`),
    and may need a variant without `pattern`/`maxLength` for providers whose structured-output
    mode rejects them. Not decided here.
