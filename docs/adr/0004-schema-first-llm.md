# ADR 0004 — Schema-first LLM output

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Rocky's AI produces triage scores, flagged hunks, draft findings with suggested patches, and a
change-map graph. Free-form model text is hard to validate, render or trust, and PR content can
contain prompt-injection attempts. Self-hosters may use weaker local models.

## Decision

1. **One analysis document per PR revision**, defined in Zod in `packages/schema`
   (graph + triage + findings) and emitted as JSON Schema. The UI, the renderer, posting and
   metering all read the AI's analysis from this document; nothing reads raw model text. PR
   metadata and diff content come from the GitHub mirror, not from the document.
2. **Every model call returns schema-valid JSON.** On Claude this uses structured outputs; for
   other providers the schema is in the prompt. The response is parsed, validated, and on
   failure the exact validation errors go back to the model for **one** repair round. If it
   still fails, the file is marked "AI couldn't analyse this" instead of showing bad output.
   (Pattern adapted from PR Lens, MIT.)
3. **Facts are not the model's to state.** Commit SHAs, file lists, line counts and diff ranges
   are written over whatever the model returns ("known fields", P1-4).
4. **Integrity checks beyond types**: graph edges reference declared nodes, findings point at
   lines inside the diff, suggestions apply to the referenced lines (P1-2).
5. **AI output has no side effects.** It only creates drafts; posting to GitHub always requires
   a human action (P3-5, P6-6).

## Consequences

- Providers are interchangeable: anything that can produce schema-valid JSON plugs in.
- Prompt injection can at worst produce a wrong draft, never an action.
- The schema is a shared contract; changes to it are reviewed as RISKY and versioned.
