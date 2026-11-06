import {
  type DraftDecision,
  postedCommentParts,
  restoredAsDraft,
} from "@rocky-reviews/core/drafts";
import { type Finding, type HiddenByDismissal, parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftOnScreenContext } from "../keyboard/draft-on-screen.js";
import { DraftCard } from "./DraftCard.js";
import { type DraftMode, ReviewContext, type ReviewContextValue } from "./ReviewProvider.js";
import { reviewWith } from "./testing.js";

/** P6-4: every state of a draft card, as the POC draws it (`renderFinding`). */

const parsed = parseAnalysisDocument(pr847);
if (!parsed.ok) throw new Error("fixture invalid");
const findings = parsed.value.findings;
/** P8-2b: the finding memory hid on the jobs file, as the draft it becomes once restored. */
const H1 = parsed.value.hidden?.find((h) => h.id === "H1");
if (H1 === undefined) throw new Error("the fixture carries H1");
const byId = (id: string) => {
  const found = findings.find((f) => f.id === id);
  if (found === undefined) throw new Error(`no finding ${id}`);
  return found;
};
const F1 = byId("F1");
const F2 = byId("F2");
/** A dismissal covered F3, but its file is critical: the double-check line (P8-2). */
const F3 = byId("F3");

const render = (
  finding: Finding,
  options: {
    decision?: DraftDecision;
    mode?: DraftMode;
    focused?: string;
    copied?: boolean;
    saving?: boolean;
    status?: ReviewContextValue["status"];
    posted?: "posting" | "posted";
    /** H4-14: the draft the on-screen tracker reports. */
    onScreen?: string;
    /** P8-2b: the dismissal that had hidden this draft (it was restored). */
    hiddenBy?: HiddenByDismissal;
  } = {},
) => {
  const value = reviewWith(
    findings,
    options.decision === undefined ? {} : { [finding.id]: options.decision },
    [],
    {
      mode: options.mode ?? null,
      focused: options.focused ?? null,
      saving: new Set(options.saving === true ? [finding.id] : []),
      status: options.status ?? "ready",
      hiddenBy: (id) => (id === finding.id ? options.hiddenBy : undefined),
    },
    options.posted === undefined ? {} : { [finding.id]: options.posted },
  );
  if (options.copied === true) {
    const drafts = new Map(value.state.drafts);
    drafts.set(finding.id, {
      findingId: finding.id,
      decision: { state: "draft" },
      agentPromptCopiedAt: "2026-10-25T12:00:00.000Z",
      posted: null,
    });
    Object.assign(value, { state: { ...value.state, drafts } });
  }
  return renderToStaticMarkup(
    <DraftOnScreenContext value={{ onScreen: options.onScreen ?? null, report: () => {} }}>
      <ReviewContext value={value}>
        <DraftCard
          finding={finding}
          original={["    role: requestedRole ?? invite.role,"]}
          language="js"
        />
      </ReviewContext>
    </DraftOnScreenContext>,
  );
};

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("an undecided draft", () => {
  const html = render(F1);

  it("has the head: AI draft, severity, confidence and who can see it", () => {
    expect(text(html)).toMatch(
      /^AI draft Critical 94% confident Only you can see this until you accept it Invitee can choose their own role, e\.g\. admin/,
    );
    expect(html).toContain('class="draft sev-critical"');
    expect(html).toContain('<h3 class="draft-title" id="draft-F1-title">');
  });

  it("renders the body's inline code as code, and the suggested change as a small diff", () => {
    expect(html).toContain("<code>requestedRole</code>");
    const suggestion = text(
      (html.split('<figure class="suggestion">')[1] ?? "").split("</figure>")[0] ?? "",
    );
    expect(suggestion).toBe(
      "Suggested change userId: user.id, − removed: role: requestedRole ?? invite.role, + added: role: invite.role,",
    );
  });

  it("H4-17: a suggested line's sign word is announced from the sign column, not its code", () => {
    const figure = html.split('<figure class="suggestion">')[1]?.split("</figure>")[0] ?? "";
    expect(figure).toContain(
      '<span class="sign"><span aria-hidden="true">+</span><span class="sr-only">added: </span></span>',
    );
    expect(figure).toContain(
      '<span class="sign"><span aria-hidden="true">−</span><span class="sr-only">removed: </span></span>',
    );
    // The code elements hold only the code.
    const code = [...figure.matchAll(/<code class="src">(.*?)<\/code>/g)].map((m) => m[1] ?? "");
    expect(code).toHaveLength(3);
    for (const c of code) expect(c).not.toMatch(/sr-only|added|removed/);
  });

  it("offers Accept, Edit, Dismiss and Send to agent", () => {
    expect(text(html.split('class="draft-actions"')[1] ?? "")).toBe(
      "> Accept Edit Dismiss Send to agent ↗",
    );
    // P6-5: focused and on screen (H4-14), each with its key hint (hidden from the accessible
    // name) and aria-keyshortcuts.
    const shown = render(F1, { focused: "F1", onScreen: "F1" });
    const actions = text(shown.split('class="draft-actions"')[1] ?? "");
    expect(actions).toBe("> Accept a Edit e Dismiss d Send to agent ↗");
    for (const [role, key] of [
      ["accept", "a"],
      ["edit", "e"],
      ["dismiss", "d"],
    ])
      expect(shown).toMatch(
        new RegExp(
          `data-role="${role}" aria-keyshortcuts="${key}">[^<]+<kbd[^>]*aria-hidden="true">${key}</kbd>`,
        ),
      );
  });

  it("H4-14: no a/e/d hints unless it is the focused draft and on screen", () => {
    for (const html of [
      render(F1),
      render(F1, { focused: "F1" }),
      render(F1, { onScreen: "F1" }),
      render(F1, { focused: "F2", onScreen: "F2" }),
    ]) {
      expect(html).not.toContain("aria-keyshortcuts");
      expect(html.split('class="draft-actions"')[1]).not.toContain("<kbd");
    }
  });

  it("shows the project-memory evidence with its source", () => {
    const t = text(render(F2));
    expect(t).toContain(
      "◆ Project memory: Org-scoped routes use requireOrgRole() · convention · PR",
    );
    expect(t).toContain(F2.memory[0]?.source ?? "missing");
  });

  it("says when a dismissal covered the draft but the file is critical: double-check", () => {
    const html = render(F3);
    expect(text(html)).toContain(
      "◆ Your team dismissed this as intentional on src/auth/invitations.ts · dismissal · PR",
    );
    expect(text(html)).toContain(
      "This file is critical, so Rocky is showing it anyway: double-check",
    );
    expect(html).toContain('class="evidence double-check"');
    // The entry's path and text are stored data, rendered as text (never markup).
    expect(html).toContain("<code><bdi>src/auth/invitations.ts</bdi></code>");
    const restoredText = F3.restored?.entry.text ?? "";
    expect(restoredText).toContain("Invitations can be reused");
    // Fix round 4, N2: the double-check line itself does not quote the entry's text (the title
    // above is the same issue; P8-3's view is where to read the entry) ...
    const line = text(html.split('class="evidence double-check"')[1]?.split("</p>")[0] ?? "");
    expect(line).toContain("Your team dismissed this as intentional");
    expect(line).not.toContain(restoredText);
    expect(line).not.toContain(F3.title);
    // ... and a path shaped like markup renders escaped, as text.
    if (F3.restored === undefined) throw new Error("F3 carries a restored marker");
    const scripted = render({
      ...F3,
      restored: { ...F3.restored, path: "src/<script>alert(1)</script>.ts" },
    });
    expect(scripted).not.toContain("<script>");
    expect(scripted).toContain("src/&lt;script&gt;alert(1)&lt;/script&gt;.ts");
    // The other reasons and the rule-floor wording.
    const restored = F3.restored;
    if (restored === undefined) throw new Error("F3 carries a restored marker");
    const variant = (over: Partial<NonNullable<Finding["restored"]>>) =>
      text(render({ ...F3, restored: { ...restored, ...over } }));
    const elsewhere = variant({ dismissedAs: "handled_elsewhere", shownBecause: "rule_floor" });
    expect(elsewhere).toContain(
      "dismissed this as already handled elsewhere on src/auth/invitations.ts",
    );
    expect(elsewhere).toContain(
      "This file always gets a full review, so Rocky is showing it anyway",
    );
    expect(variant({ dismissedAs: "not_an_issue" })).toContain(
      "dismissed this as not a real issue",
    );
    expect(variant({ dismissedAs: "not_worth_it" })).toContain("dismissed this as not worth it");
    // Without the marker (every other draft) there is no such line.
    expect(render(F1)).not.toContain("double-check");
  });

  it("P8-2b: a draft restored from the hidden list says which dismissal had hidden it", () => {
    const draft = restoredAsDraft(H1);
    const html = render(draft, { hiddenBy: H1.hiddenBy });
    const line = text(html.split('class="evidence double-check">')[1]?.split("</p>")[0] ?? "");
    expect(line).toBe(
      `◆ Your team dismissed this as intentional on src/jobs/sendInviteEmail.ts · ${H1.hiddenBy.entry.source} . Rocky had hidden it; you restored it.`,
    );
    expect(line).not.toContain(H1.hiddenBy.entry.text);
    // A restored draft is a draft: the same actions.
    expect(text(html.split('class="draft-actions"')[1] ?? "")).toContain("Accept");
    // Not restored (no record): no such line; nor on any other draft.
    expect(render(draft)).not.toContain("you restored it");
    expect(render(F1)).not.toContain("you restored it");
  });

  it("has the focus ring when focused, and notes a copied fix prompt", () => {
    expect(render(F1, { focused: "F1" })).toContain('class="draft sev-critical focus"');
    expect(text(render(F1, { copied: true }))).toContain("✓ Fix prompt copied Send to agent");
  });

  it("is marked busy while a decision is being saved, its buttons still focusable", () => {
    const html = render(F1, { saving: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/data-role="accept"[^>]*disabled/);
  });
});

describe("editing and dismissing", () => {
  it("edit: the body in a labelled textarea, Save as my comment and Cancel", () => {
    const html = render(F1, { mode: { kind: "edit", findingId: "F1", text: "My <b>words</b>" } });
    expect(html).toContain('<label class="sr-only" for="edit-F1">');
    expect(html).toMatch(/<textarea id="edit-F1"[^>]*>My &lt;b&gt;words&lt;\/b&gt;<\/textarea>/);
    expect(text(html)).toContain("Save as my comment Cancel");
    expect(html).not.toContain('data-role="accept"');
  });

  it("an empty edit cannot be saved", () => {
    const html = render(F1, { mode: { kind: "edit", findingId: "F1", text: "  " } });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save as my comment</);
  });

  it("dismiss: the four reasons and Cancel, in a labelled group", () => {
    const html = render(F1, { mode: { kind: "dismiss", findingId: "F1" } });
    expect(html).toMatch(/role="group" aria-labelledby="draft-F1-title-why"/);
    expect(text(html.split('id="draft-F1-title-why">')[1] ?? "")).toBe(
      "Why? Rocky keeps your reason so future reviews can learn from it. Not a real issue 1 Intentional 2 Not worth it here 3 Already handled elsewhere 4 Cancel",
    );
    // H4-14: each reason with its key, hidden from its name.
    expect(html).toMatch(
      /aria-keyshortcuts="2">Intentional <kbd aria-hidden="true">2<\/kbd><\/button>/,
    );
  });

  it("another draft's mode does not open this one", () => {
    expect(render(F1, { mode: { kind: "dismiss", findingId: "F2" } })).toContain(
      'data-role="accept"',
    );
  });
});

describe("before the reviewer's decisions are loaded", () => {
  it("is read-only while they load: no actions, says why", () => {
    const html = render(F1, { status: "loading" });
    expect(html).not.toContain('data-role="accept"');
    expect(html).not.toContain('data-role="agent"');
    expect(text(html)).toContain("Loading your decisions…");
  });

  it("is read-only when they could not be loaded, and says so", () => {
    const html = render(F1, { status: "failed" });
    expect(html).not.toContain('data-role="accept"');
    expect(text(html)).toContain(
      "Your decisions could not be loaded, so this draft cannot be decided. Reload the page to try again.",
    );
  });
});

describe("decided drafts", () => {
  it("accepted: the reviewer's pending comment, from the AI draft, with Undo", () => {
    const html = render(F1, { decision: { state: "accepted", edited: false, body: F1.body } });
    expect(text(html)).toMatch(/^Y you Pending · from AI draft Undo Invitee can choose/);
    expect(html).toContain('class="mine from-draft"');
    expect(html).toContain("Suggested change");
  });

  it("accepted after an edit: says so, and shows the reviewer's text as text", () => {
    const html = render(F1, {
      decision: { state: "accepted", edited: true, body: "Use `invite.role` <img src=x>" },
    });
    expect(text(html)).toContain("· edited from AI draft");
    expect(html).toContain("<code>invite.role</code>");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<img");
  });

  it("accepted shows exactly what Finish review will post (core postedCommentParts)", () => {
    const body = "Always use the invited role.";
    const html = render(F1, { decision: { state: "accepted", edited: true, body } });
    const parts = postedCommentParts(F1, { body });
    expect(text(html.split('id="draft-F1-title">')[1]?.split("</h3>")[0] ?? "")).toBe(parts.title);
    expect(text(html.split('class="mine-body">')[1]?.split("</p>")[0] ?? "")).toBe(parts.body);
    const added = [...html.matchAll(/added: <\/span>(.*?)<\/code>/g)].map((m) => text(m[1] ?? ""));
    expect(added).toEqual(parts.suggestion?.map((line) => line.trim()));
    // Nothing that is not posted: no severity, no confidence, no project-memory evidence.
    expect(text(html)).not.toMatch(/Critical|confident|Seen in/);
    // Nor the double-check line of a restored draft (F3): it is not posted either.
    const restored = render(F3, { decision: { state: "accepted", edited: false, body: F3.body } });
    expect(text(restored)).not.toContain("double-check");
  });

  it("accepted and posted to GitHub (P6-6): says Posted, read-only, no Undo", () => {
    const decision = { state: "accepted", edited: false, body: F1.body } as const;
    const posted = render(F1, { decision, posted: "posted" });
    expect(text(posted)).toMatch(/^Y you Posted to GitHub, read-only · from AI draft Invitee/);
    expect(posted).not.toContain('data-role="undo"');
    expect(posted).toContain('data-posted="posted"');
    expect(posted).toContain('class="pending posted"');
    // H4-17: its screen-reader words are not copied with a selection across the diff.
    expect(posted).toContain('<span class="sr-only no-copy"> to GitHub, read-only</span>');
    const posting = render(F1, { decision, posted: "posting" });
    expect(text(posting)).toContain("you Posting… , read-only");
    expect(posting).not.toContain("<button");
  });

  it("undecided but already posted from a re-run (P6-6): one read-only line, no actions", () => {
    const html = render(F1, { posted: "posted", decision: { state: "draft" } });
    expect(text(html)).toBe(
      "AI draft Invitee can choose their own role, e.g. admin (already posted to GitHub from an earlier analysis of this commit) Posted to GitHub, read-only",
    );
    expect(html).not.toContain("<button");
  });

  it("dismissed: one collapsed line with the reason and Undo", () => {
    const html = render(F1, { decision: { state: "dismissed", reason: "intentional" } });
    expect(text(html)).toBe(
      "AI draft dismissed · Invitee can choose their own role, e.g. admin (Intentional) Undo",
    );
    expect(html).toContain('class="collapsed-draft"');
  });
});
