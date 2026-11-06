/**
 * Fixtures for the briefing's other states (P6-2), served by the fixture source next to pr-847
 * under their own PR numbers in the same repository. The documents are pr-847 changed the way
 * the pipeline would change it; they still pass `parseAnalysisDocument`, integrity included.
 * Open one in the dev server with `?pr=<number>`.
 */
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import type { RawShellData } from "../data/shell-data.js";

export const BRIEFING_FIXTURE_PULLS = {
  briefingUnavailable: 848,
  graphUnavailable: 849,
  none: 850,
  running: 851,
  awaitingApproval: 852,
  failed: 853,
  superseded: 854,
  reanalysing: 855,
  outOfDate: 856,
  noTour: 857,
  summaryOnly: 858,
} as const;

/** A push after the analysed commit: the PR's head in the re-analysing and out-of-date states. */
const NEWER_HEAD = "1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d";
export type BriefingFixture = keyof typeof BRIEFING_FIXTURE_PULLS;

type Doc = typeof pr847 & Record<string, unknown>;

/** pr-847's document re-numbered, with `change` applied to a copy. */
const variant = (number: number, change: (doc: Doc) => void): Doc => {
  const doc = structuredClone(pr847) as Doc;
  doc.provenance.pullRequest.number = number;
  change(doc);
  return doc;
};

/** A briefing with the summary paragraph instead of the TL;DR, as before schema 1.4 (H4-8). */
const withSummary = (doc: Doc, summary: string) => {
  const briefing = doc.briefing as Partial<Doc["briefing"]> & { summary?: string };
  delete briefing.tldr;
  briefing.summary = summary;
};

/** The briefing as `analyzePullRequest` writes it when the AI briefing fails (P4-4). */
const briefingUnavailable = variant(BRIEFING_FIXTURE_PULLS.briefingUnavailable, (doc) => {
  // Rocky's own briefing has the summary paragraph; its document is stamped 1.1.
  doc.schemaVersion = "1.1.0";
  withSummary(
    doc,
    "Rocky could not produce an AI briefing for this pull request. The level below comes from Rocky's rules, the triage and the draft findings. Read the files in the order shown.",
  );
  doc.briefing.verdict.reason =
    "Set by Rocky from its rules, the triage and the draft findings, because the AI briefing was unavailable.";
  doc.briefing.reviewPath = doc.briefing.reviewPath.map((step) => {
    const file = doc.triage.files.find((f) => f.path === step.path);
    return { path: step.path, why: `Triaged ${file?.level} (score ${file?.score}).` };
  });
  doc.briefing.checkedOk = [];
  doc.briefing.memoryApplied = [];
  // Memory a finding cites must be in the briefing's list, so the fallback cites none; nor can
  // a hidden finding cite the dismissal that hid it (P8-2b), so the fallback hides none.
  for (const finding of doc.findings) finding.memory = [];
  delete (doc as { hidden?: unknown }).hidden;
  Object.assign(doc.provenance, { briefingUnavailable: { reason: "analysis-failed" } });
});

/** No change map; one file the AI could not analyse and one risky file to read by hand. */
const graphUnavailable = variant(BRIEFING_FIXTURE_PULLS.graphUnavailable, (doc) => {
  delete (doc as { graph?: unknown }).graph;
  const unanalysed = "src/api/index.ts";
  const quiet = "src/jobs/sendInviteEmail.ts";
  doc.triage.files = doc.triage.files.filter((f) => f.path !== unanalysed);
  doc.findings = doc.findings.filter((f) => f.path !== quiet);
  // The quiet file is read by hand: nothing of it is listed, hidden findings included (P8-2b).
  doc.hidden = doc.hidden?.filter((h) => h.path !== quiet);
  Object.assign(doc.provenance, {
    graphUnavailable: { reason: "too-large" },
    unanalysed: [{ path: unanalysed, reason: "timeout" }],
    readByHand: [{ path: quiet }],
  });
});

/** H4-6: a map with no walkthrough and no flows, so the guided styles fall back to Live traffic. */
const noTour = variant(BRIEFING_FIXTURE_PULLS.noTour, (doc) => {
  const graph = doc.graph as Record<string, unknown>;
  delete graph.walkthrough;
  graph.flows = [];
  // The view that named the flow keeps its nodes and edges.
  graph.views = [];
});

/**
 * H4-8: a document written before schema 1.4, with the summary paragraph and a two-sentence
 * reason instead of the TL;DR. The briefing shows it as it always did.
 */
const summaryOnly = variant(BRIEFING_FIXTURE_PULLS.summaryOnly, (doc) => {
  doc.schemaVersion = "1.3.0";
  withSummary(
    doc,
    "Adds **email invitations to orgs**. An admin creates an invite, a background job emails a 7-day link, and the invitee accepts it to join the org with the invited role.",
  );
  doc.briefing.verdict.reason =
    "This PR adds a **new way to gain membership in an org**. Rocky drafted 1 critical and 3 high findings, all on the auth path. The UI and wiring look routine.";
});

const n = BRIEFING_FIXTURE_PULLS;
/** The state fixtures, as `base` (GitHub's view of pr-847) under each state's number. */
export const briefingFixtures = (base: object): RawShellData[] => {
  const pull = (number: number, headSha?: string) => ({
    ...base,
    number,
    ...(headSha === undefined ? {} : { headSha }),
  });
  return [
    { pull: pull(n.briefingUnavailable), myReview: null, analysis: briefingUnavailable },
    { pull: pull(n.graphUnavailable), myReview: null, analysis: graphUnavailable },
    { pull: pull(n.none), myReview: null, analysis: null, analysisRun: { status: "none" } },
    { pull: pull(n.running), myReview: null, analysis: null, analysisRun: { status: "running" } },
    {
      pull: pull(n.awaitingApproval),
      myReview: null,
      analysis: null,
      analysisRun: { status: "awaiting_approval", estimatedTokens: 212_000, limitTokens: 150_000 },
    },
    {
      pull: pull(n.failed),
      myReview: null,
      analysis: null,
      analysisRun: { status: "failed", code: "repository_inaccessible" },
    },
    {
      pull: pull(n.reanalysing, NEWER_HEAD),
      myReview: null,
      analysis: variant(n.reanalysing, () => {}),
      analysisRun: { status: "running" },
    },
    {
      pull: pull(n.outOfDate, NEWER_HEAD),
      myReview: null,
      analysis: variant(n.outOfDate, () => {}),
      analysisRun: { status: "done" },
    },
    { pull: pull(n.noTour), myReview: null, analysis: noTour },
    { pull: pull(n.summaryOnly), myReview: null, analysis: summaryOnly },
    {
      pull: pull(n.superseded),
      myReview: null,
      analysis: null,
      analysisRun: { status: "failed", code: "superseded" },
    },
  ];
};
