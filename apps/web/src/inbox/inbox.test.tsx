import { assessPullRequest, groupInbox, type InboxItem } from "@rocky-reviews/core";
import { parseAnalysisDocument } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INBOX_FIXTURE, INBOX_FIXTURE_NOW, INBOX_FIXTURE_VIEWER } from "./fixtures.js";
import { Inbox } from "./Inbox.js";
import { notOfferedBecause, reviewHref } from "./inbox-model.js";
import {
  createFixtureInboxSource,
  createHttpInboxSource,
  InboxLoadError,
  parseInbox,
} from "./inbox-source.js";

const NOW = Date.parse(INBOX_FIXTURE_NOW);
const inbox = parseInbox(INBOX_FIXTURE);
const byNumber = (n: number): InboxItem => {
  const item = inbox.items.find((i) => i.number === n);
  if (item === undefined) throw new Error(`no fixture PR #${n}`);
  return item;
};

describe("the inbox fixture (P6-7)", () => {
  it("is valid wire data", () => {
    expect(inbox.items).toHaveLength(11);
  });

  it("says about pr-847 what assessPullRequest says about the pr-847 analysis", () => {
    const parsed = parseAnalysisDocument(pr847);
    if (!parsed.ok) throw new Error("pr-847 fixture");
    const row = byNumber(847);
    const assessed = assessPullRequest({
      state: "open",
      headSha: row.headSha,
      authorLogin: row.author,
      viewerLogin: INBOX_FIXTURE_VIEWER,
      size: row.size,
      diffIncomplete: false,
      analysis: { status: "done", headSha: row.headSha, document: parsed.value },
    });
    expect(assessed).toEqual({
      risk: row.risk,
      analysis: row.analysis,
      findings: row.findings,
      estimatedMinutes: row.estimatedMinutes,
      bulkApproval: row.bulkApproval,
    });
  });

  it("offers exactly the low-risk PRs nothing blocks", () => {
    const { safe } = groupInbox(inbox.items);
    expect(safe.map((i) => i.number)).toEqual([41, 309, 205]);
  });
});

describe("Inbox (static render)", () => {
  const render = (items: readonly InboxItem[] = inbox.items) =>
    renderToStaticMarkup(
      <Inbox
        items={items}
        now={NOW}
        mode="light"
        onToggleMode={() => undefined}
        source={createFixtureInboxSource()}
        onReload={() => undefined}
      />,
    );

  it("selects nothing and disables approval until the person ticks a PR", () => {
    const html = render();
    expect(html).not.toMatch(/checked=""/);
    expect(html).toMatch(
      /<button type="button" class="btn btn-primary" disabled="">Approve selected…<\/button>/,
    );
    // No dialog until the button is pressed.
    expect(html).not.toContain("<dialog");
  });

  it("renders PR text as text and links only to the review page", () => {
    const hostile: InboxItem = {
      ...byNumber(205),
      title: '<img src=x onerror="alert(1)"> ‮evil',
      author: "x[bot]",
    };
    const html = render([hostile]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain('href="/?repo=acme%2Fweb&amp;pr=205"');
    expect(html.match(/href="/g)).toHaveLength(2); // skip link + the row's title
  });

  it("says why there is nothing to offer", () => {
    const html = render(inbox.items.filter((i) => !i.bulkApproval.eligible));
    expect(html).toContain("Nothing to bulk-approve right now.");
  });
});

describe("labels", () => {
  it("explains a low-risk PR that is not offered, and nothing else", () => {
    expect(notOfferedBecause(byNumber(850))).toBe("1 AI finding");
    expect(notOfferedBecause(byNumber(210))).toBe("Your pull request");
    expect(notOfferedBecause(byNumber(201))).toBeNull(); // the analysis note says it
    expect(notOfferedBecause(byNumber(847))).toBeNull(); // not low risk
    expect(notOfferedBecause(byNumber(205))).toBeNull(); // offered
    expect(
      notOfferedBecause({
        ...byNumber(205),
        bulkApproval: { eligible: false, blockers: ["too_large"] },
      }),
    ).toBe("Too large to bulk-approve");
  });

  it("builds the review link from the names, encoded", () => {
    expect(reviewHref({ repo: { owner: "acme", name: "rocky-app" }, number: 847 })).toBe(
      "/?repo=acme%2Frocky-app&pr=847",
    );
  });
});

describe("parseInbox", () => {
  it("refuses data that is not the wire format, without echoing it", () => {
    for (const bad of [null, {}, { items: [{ id: "x" }], truncated: false }]) {
      expect(() => parseInbox(bad)).toThrow(InboxLoadError);
    }
  });
});

describe("the HTTP source", () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (routes: Record<string, { status: number; body?: unknown }>) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const answer = routes[`${init?.method ?? "GET"} ${url}`];
      if (answer === undefined) throw new Error(`unexpected ${url}`);
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status,
      });
    });
    return calls;
  };
  const session = { status: 200, body: { authenticated: true, csrfToken: "tok" } };
  const id205 = byNumber(205).id;
  const batch = { pullRequests: [{ id: id205, headSha: byNumber(205).headSha }] };

  it("loads the inbox, and says when the person is signed out", async () => {
    respond({ "GET /api/inbox": { status: 200, body: INBOX_FIXTURE } });
    expect(await createHttpInboxSource().load()).toEqual(INBOX_FIXTURE);
    respond({ "GET /api/inbox": { status: 401 } });
    await expect(createHttpInboxSource().load()).rejects.toMatchObject({ reason: "signed_out" });
    respond({ "GET /api/inbox": { status: 503 } });
    await expect(createHttpInboxSource().load()).rejects.toMatchObject({ reason: "failed" });
  });

  it("posts one batch with the session's CSRF token", async () => {
    const calls = respond({
      "GET /api/session": session,
      "POST /api/inbox/approvals": {
        status: 200,
        body: { results: [{ id: byNumber(205).id, outcome: "approved" }] },
      },
    });
    expect(await createHttpInboxSource().approve(batch)).toEqual({
      kind: "done",
      results: [{ id: byNumber(205).id, outcome: "approved" }],
    });
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.init?.headers).toMatchObject({ "x-rocky-csrf": "tok" });
    expect(JSON.parse(String(post?.init?.body))).toEqual(batch);
  });

  it("maps refusals, an unavailable server and anything unexpected", async () => {
    respond({
      "GET /api/session": session,
      "POST /api/inbox/approvals": {
        status: 409,
        body: {
          error: "batch_refused",
          refusals: [{ id: id205, reason: "head_moved" }],
        },
      },
    });
    expect(await createHttpInboxSource().approve(batch)).toEqual({
      kind: "refused",
      refusals: [{ id: id205, reason: "head_moved" }],
    });
    respond({ "GET /api/session": session, "POST /api/inbox/approvals": { status: 503 } });
    expect(await createHttpInboxSource().approve(batch)).toEqual({ kind: "unavailable" });
    // Results that name other PRs than the batch are not believed.
    respond({
      "GET /api/session": session,
      "POST /api/inbox/approvals": {
        status: 200,
        body: { results: [{ id: byNumber(41).id, outcome: "approved" }] },
      },
    });
    expect(await createHttpInboxSource().approve(batch)).toEqual({ kind: "error" });
    respond({ "GET /api/session": { status: 401 } });
    expect(await createHttpInboxSource().approve(batch)).toEqual({ kind: "error" });
  });
});

describe("the fixture source", () => {
  it("answers a batch and leaves the approved PRs out of the next load", async () => {
    const source = createFixtureInboxSource({ delayMs: 0 });
    const result = await source.approve({
      pullRequests: [{ id: byNumber(41).id, headSha: byNumber(41).headSha }],
    });
    expect(result).toEqual({
      kind: "done",
      results: [{ id: byNumber(41).id, outcome: "approved" }],
    });
    const next = parseInbox(await source.load());
    expect(next.items.map((i) => i.number)).not.toContain(41);
    expect(next.items).toHaveLength(10);
  });
});
