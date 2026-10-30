import {
  type AnalysisDocument,
  type AnalysisDocumentInput,
  parseAnalysisDocument,
} from "@rocky-reviews/schema";
import pr847Json from "@rocky-reviews/schema/fixtures/pr-847.json" with { type: "json" };
import tinyJson from "@rocky-reviews/schema/fixtures/tiny.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import {
  assessPullRequest,
  BULK_APPROVE_BLOCKERS,
  BulkApproveRequest,
  BulkApproveResponse,
  compareInboxItems,
  groupInbox,
  type InboxFacts,
  InboxItem,
  InboxResponse,
  matchesFilter,
  MAX_BULK_APPROVE_BATCH,
  MAX_BULK_APPROVE_LINES,
  NO_FILTER,
  riskRank,
  sortInbox,
} from "./review-inbox.js";

const parse = (input: unknown): AnalysisDocument => {
  const result = parseAnalysisDocument(input);
  if (!result.ok) throw new Error(`fixture: ${result.error.code}`);
  return result.value;
};

const clone = <T>(value: T): T => structuredClone(value);
const tiny = (): AnalysisDocumentInput => clone(tinyJson) as AnalysisDocumentInput;
const TINY_HEAD = tinyJson.provenance.head.sha;
const PR847_HEAD = pr847Json.provenance.head.sha;

/** A small, current, low-risk PR by someone else: everything passes. */
const facts = (overrides: Partial<InboxFacts> = {}, document = parse(tiny())): InboxFacts => ({
  state: "open",
  headSha: TINY_HEAD,
  authorLogin: "dana-k",
  viewerLogin: "sam-r",
  size: { additions: 1, deletions: 1 },
  diffIncomplete: false,
  analysis: { status: "done", headSha: TINY_HEAD, document },
  ...overrides,
});

describe("assessPullRequest: safe to bulk-approve (P6-7)", () => {
  it("offers a small, current, low-risk PR with no findings by someone else", () => {
    const result = assessPullRequest(facts());
    expect(result).toEqual({
      risk: "low",
      analysis: "done",
      findings: { critical: 0, high: 0, medium: 0, low: 0 },
      estimatedMinutes: 1,
      bulkApproval: { eligible: true, blockers: [] },
    });
  });

  it("never offers pr-847 (critical verdict, findings, risky files, auth paths)", () => {
    const doc = parse(clone(pr847Json));
    const result = assessPullRequest(
      facts({
        headSha: PR847_HEAD,
        size: { additions: 215, deletions: 3 },
        analysis: { status: "done", headSha: PR847_HEAD, document: doc },
      }),
    );
    expect(result.risk).toBe("critical");
    expect(result.findings.critical).toBeGreaterThan(0);
    expect(result.bulkApproval.eligible).toBe(false);
    expect(result.bulkApproval.blockers).toEqual(
      expect.arrayContaining(["risk_not_low", "findings", "risky_files", "sensitive_paths"]),
    );
  });

  const blocked: [string, () => InboxFacts, string][] = [
    ["a closed PR", () => facts({ state: "closed" }), "not_open"],
    ["a merged PR", () => facts({ state: "merged" }), "not_open"],
    ["the viewer's own PR (any case)", () => facts({ authorLogin: "SAM-R" }), "own_pull_request"],
    ["no analysis", () => facts({ analysis: null }), "no_current_analysis"],
    [
      "an analysis still running",
      () => facts({ analysis: { status: "running", headSha: TINY_HEAD, document: null } }),
      "no_current_analysis",
    ],
    [
      "an analysis waiting for Analyze anyway",
      () =>
        facts({ analysis: { status: "awaiting_approval", headSha: TINY_HEAD, document: null } }),
      "no_current_analysis",
    ],
    [
      "a failed analysis",
      () => facts({ analysis: { status: "failed", headSha: TINY_HEAD, document: null } }),
      "no_current_analysis",
    ],
    [
      "a done analysis whose document is unreadable",
      () => facts({ analysis: { status: "done", headSha: TINY_HEAD, document: null } }),
      "no_current_analysis",
    ],
    [
      "an analysis of an older push",
      () => facts({ headSha: "f".repeat(40) }),
      "no_current_analysis",
    ],
    [
      "a medium verdict",
      () => {
        const doc = tiny();
        doc.briefing.verdict.level = "medium";
        return facts({}, parse(doc));
      },
      "risk_not_low",
    ],
    [
      "a low finding",
      () => {
        const doc = tiny();
        doc.findings = [
          {
            id: "f-1",
            path: "README.md",
            range: { start: 10, end: 10 },
            severity: "low",
            confidence: 60,
            title: "Wording",
            body: "Consider a shorter sentence.",
            agentPrompt: "Shorten the sentence on line 10 of README.md.",
          },
        ];
        return facts({}, parse(doc));
      },
      "findings",
    ],
    [
      "a file triaged important",
      () => {
        const doc = tiny();
        doc.triage.files[0]!.level = "important";
        doc.triage.files[0]!.score = 60;
        return facts({}, parse(doc));
      },
      "risky_files",
    ],
    [
      "a migration path (Rocky's rules, not the model)",
      () => {
        const doc = tiny();
        const path = "db/migrations/0001_init.sql";
        doc.provenance.files[0]!.path = path;
        doc.briefing.reviewPath[0]!.path = path;
        doc.triage.files[0]!.path = path;
        return facts({}, parse(doc));
      },
      "sensitive_paths",
    ],
    [
      "a file the AI could not analyse",
      () => {
        const doc = tiny();
        doc.provenance.files.push({
          path: "assets/logo.png",
          status: "modified",
          additions: 0,
          deletions: 0,
          hunks: [],
        });
        doc.provenance.unanalysed = [{ path: "assets/logo.png", reason: "binary" }];
        doc.briefing.verdict.level = "medium";
        return facts({}, parse(doc));
      },
      "unanalysed_files",
    ],
    [
      "a briefing Rocky wrote itself",
      () => {
        const doc = tiny();
        doc.provenance.briefingUnavailable = { reason: "timeout" };
        return facts({}, parse(doc));
      },
      "briefing_by_rocky",
    ],
    ["a truncated diff", () => facts({ diffIncomplete: true }), "diff_incomplete"],
    ["a diff never read", () => facts({ size: null }), "diff_incomplete"],
    [
      `more than ${MAX_BULK_APPROVE_LINES} changed lines`,
      () => facts({ size: { additions: MAX_BULK_APPROVE_LINES, deletions: 1 } }),
      "too_large",
    ],
  ];

  for (const [name, make, blocker] of blocked) {
    it(`does not offer ${name} (${blocker})`, () => {
      const result = assessPullRequest(make());
      expect(result.bulkApproval.eligible).toBe(false);
      expect(result.bulkApproval.blockers).toContain(blocker);
    });
  }

  it("offers exactly the limit of changed lines", () => {
    const result = assessPullRequest(
      facts({ size: { additions: MAX_BULK_APPROVE_LINES - 1, deletions: 1 } }),
    );
    expect(result.bulkApproval.eligible).toBe(true);
  });

  it("reads a read-by-hand file as a blocker", () => {
    const doc = parse(tiny());
    const withReadByHand = {
      ...doc,
      provenance: { ...doc.provenance, readByHand: [{ path: "README.md" }] },
    } as AnalysisDocument;
    expect(assessPullRequest(facts({}, withReadByHand)).bulkApproval.blockers).toContain(
      "read_by_hand",
    );
  });

  it("flags a verdict below what the document's own facts floor it at", () => {
    const doc = parse(tiny());
    const lowered = {
      ...doc,
      findings: [
        {
          id: "f-1",
          path: "README.md",
          range: { start: 10, end: 10 },
          severity: "critical",
          confidence: 90,
          title: "x",
          body: "y",
          memory: [],
        },
      ],
    } as unknown as AnalysisDocument;
    expect(assessPullRequest(facts({}, lowered)).bulkApproval.blockers).toContain(
      "verdict_below_floor",
    );
  });

  it("ignores a document that names another commit than its revision", () => {
    const result = assessPullRequest(
      facts({
        analysis: { status: "done", headSha: TINY_HEAD, document: parse(clone(pr847Json)) },
      }),
    );
    expect(result).toMatchObject({ risk: "unknown", analysis: "failed" });
    expect(result.findings).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(result.bulkApproval.blockers).toContain("no_current_analysis");
  });

  it("keeps an older push's risk but says it is out of date", () => {
    const result = assessPullRequest(facts({ headSha: "f".repeat(40) }));
    expect(result).toMatchObject({ risk: "low", analysis: "out_of_date" });
  });

  it("reports a queued analysis of the head, and nothing for an old push's unfinished one", () => {
    expect(
      assessPullRequest(
        facts({ analysis: { status: "queued", headSha: TINY_HEAD, document: null } }),
      ).analysis,
    ).toBe("queued");
    expect(
      assessPullRequest(
        facts({
          headSha: "f".repeat(40),
          analysis: { status: "failed", headSha: TINY_HEAD, document: null },
        }),
      ).analysis,
    ).toBe("none");
  });

  it("uses only known blocker codes", () => {
    const result = assessPullRequest(
      facts({ state: "closed", authorLogin: "sam-r", analysis: null, size: null }),
    );
    for (const blocker of result.bulkApproval.blockers) {
      expect(BULK_APPROVE_BLOCKERS).toContain(blocker);
    }
  });
});

const item = (overrides: Partial<InboxItem> = {}): InboxItem => ({
  id: "00000000-0000-4000-8000-000000000001",
  repo: { owner: "acme", name: "web" },
  number: 1,
  title: "A change",
  author: "dana-k",
  headSha: "a".repeat(40),
  updatedAt: "2026-10-25T12:00:00.000Z",
  size: { additions: 1, deletions: 1, files: 1 },
  risk: "low",
  analysis: "done",
  findings: { critical: 0, high: 0, medium: 0, low: 0 },
  estimatedMinutes: 1,
  bulkApproval: { eligible: true, blockers: [] },
  ...overrides,
});

describe("sorting by risk", () => {
  it("ranks critical, high, medium, unknown, low", () => {
    expect(
      ["low", "unknown", "critical", "medium", "high"].toSorted(
        (a, b) => riskRank(a as never) - riskRank(b as never),
      ),
    ).toEqual(["critical", "high", "medium", "unknown", "low"]);
  });

  it("puts the riskiest first, then more serious findings, then the longest waiting", () => {
    const items = [
      item({ number: 1, risk: "low" }),
      item({ number: 2, risk: "high", findings: { critical: 0, high: 1, medium: 0, low: 0 } }),
      item({ number: 3, risk: "high", findings: { critical: 0, high: 2, medium: 0, low: 0 } }),
      item({ number: 4, risk: "critical" }),
      item({ number: 5, risk: "unknown" }),
      item({ number: 6, risk: "medium", updatedAt: "2026-10-25T13:00:00.000Z" }),
      item({ number: 7, risk: "medium", updatedAt: "2026-10-24T13:00:00.000Z" }),
    ];
    expect(sortInbox(items).map((i) => i.number)).toEqual([4, 3, 2, 7, 6, 5, 1]);
  });

  it("is a stable total order (repository, then number)", () => {
    const a = item({ repo: { owner: "acme", name: "api" }, number: 9 });
    const b = item({ repo: { owner: "acme", name: "web" }, number: 1 });
    const c = item({ repo: { owner: "acme", name: "web" }, number: 2 });
    expect(compareInboxItems(a, b)).toBeLessThan(0);
    expect(compareInboxItems(c, b)).toBeGreaterThan(0);
    expect(compareInboxItems(b, b)).toBe(0);
  });
});

describe("filters", () => {
  const pr = item({
    repo: { owner: "acme", name: "Web" },
    number: 205,
    title: "Fix typo in onboarding",
  });

  it("matches everything without a filter", () => {
    expect(matchesFilter(pr, NO_FILTER)).toBe(true);
  });

  it("filters by repository (case-insensitive) and risk", () => {
    expect(matchesFilter(pr, { ...NO_FILTER, repo: "acme/web" })).toBe(true);
    expect(matchesFilter(pr, { ...NO_FILTER, repo: "acme/api" })).toBe(false);
    expect(matchesFilter(pr, { ...NO_FILTER, risk: "low" })).toBe(true);
    expect(matchesFilter(pr, { ...NO_FILTER, risk: "high" })).toBe(false);
  });

  it("searches the title, the repository and the number", () => {
    expect(matchesFilter(pr, { ...NO_FILTER, query: "  TYPO " })).toBe(true);
    expect(matchesFilter(pr, { ...NO_FILTER, query: "acme/we" })).toBe(true);
    expect(matchesFilter(pr, { ...NO_FILTER, query: "#205" })).toBe(true);
    expect(matchesFilter(pr, { ...NO_FILTER, query: "205" })).toBe(true);
    expect(matchesFilter(pr, { ...NO_FILTER, query: "#20" })).toBe(false);
    expect(matchesFilter(pr, { ...NO_FILTER, query: "billing" })).toBe(false);
  });
});

describe("grouping", () => {
  it("separates the offered batch from the rest, both sorted", () => {
    const blocked = { eligible: false, blockers: ["findings" as const] };
    const groups = groupInbox([
      item({ number: 1 }),
      item({ number: 2, risk: "critical", bulkApproval: blocked }),
      item({ number: 3, updatedAt: "2026-10-20T00:00:00.000Z" }),
      item({ number: 4, bulkApproval: blocked }),
    ]);
    expect(groups.safe.map((i) => i.number)).toEqual([3, 1]);
    expect(groups.review.map((i) => i.number)).toEqual([2, 4]);
  });
});

describe("wire format", () => {
  it("accepts an inbox item and refuses eligible-with-blockers", () => {
    expect(InboxItem.safeParse(item()).success).toBe(true);
    expect(
      InboxItem.safeParse(item({ bulkApproval: { eligible: true, blockers: ["findings"] } }))
        .success,
    ).toBe(false);
    expect(
      InboxItem.safeParse(item({ bulkApproval: { eligible: false, blockers: [] } })).success,
    ).toBe(false);
  });

  it("refuses unknown fields, bad logins and duplicate ids", () => {
    expect(InboxItem.safeParse({ ...item(), html: "<b>" }).success).toBe(false);
    expect(InboxItem.safeParse(item({ author: "a b" })).success).toBe(false);
    expect(InboxResponse.safeParse({ items: [item(), item()], truncated: false }).success).toBe(
      false,
    );
  });

  it("bounds a batch: 1 to the maximum, unique ids, full SHAs", () => {
    const one = { id: item().id, headSha: "a".repeat(40) };
    expect(BulkApproveRequest.safeParse({ pullRequests: [one] }).success).toBe(true);
    expect(BulkApproveRequest.safeParse({ pullRequests: [] }).success).toBe(false);
    expect(BulkApproveRequest.safeParse({ pullRequests: [one, one] }).success).toBe(false);
    expect(
      BulkApproveRequest.safeParse({ pullRequests: [{ ...one, headSha: "abc" }] }).success,
    ).toBe(false);
    const many = Array.from({ length: MAX_BULK_APPROVE_BATCH + 1 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      headSha: "a".repeat(40),
    }));
    expect(BulkApproveRequest.safeParse({ pullRequests: many }).success).toBe(false);
    expect(
      BulkApproveRequest.safeParse({ pullRequests: many.slice(0, MAX_BULK_APPROVE_BATCH) }).success,
    ).toBe(true);
  });

  it("accepts approval results with known outcomes only", () => {
    expect(
      BulkApproveResponse.safeParse({ results: [{ id: item().id, outcome: "approved" }] }).success,
    ).toBe(true);
    expect(
      BulkApproveResponse.safeParse({ results: [{ id: item().id, outcome: "merged" }] }).success,
    ).toBe(false);
  });
});
