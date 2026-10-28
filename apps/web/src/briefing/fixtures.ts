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

/** The briefing as `analyzePullRequest` writes it when the AI briefing fails (P4-4). */
const briefingUnavailable = variant(BRIEFING_FIXTURE_PULLS.briefingUnavailable, (doc) => {
  doc.briefing.summary =
    "Rocky could not produce an AI briefing for this pull request. The level below comes from Rocky's rules, the triage and the draft findings. Read the files in the order shown.";
  doc.briefing.verdict.reason =
    "Set by Rocky from its rules, the triage and the draft findings, because the AI briefing was unavailable.";
  doc.briefing.reviewPath = doc.briefing.reviewPath.map((step) => {
    const file = doc.triage.files.find((f) => f.path === step.path);
    return { path: step.path, why: `Triaged ${file?.level} (score ${file?.score}).` };
  });
  doc.briefing.checkedOk = [];
  doc.briefing.memoryApplied = [];
  // Memory a finding cites must be in the briefing's list, so the fallback cites none.
  for (const finding of doc.findings) finding.memory = [];
  Object.assign(doc.provenance, { briefingUnavailable: { reason: "analysis-failed" } });
});

/** No change map; one file the AI could not analyse and one risky file to read by hand. */
const graphUnavailable = variant(BRIEFING_FIXTURE_PULLS.graphUnavailable, (doc) => {
  delete (doc as { graph?: unknown }).graph;
  const unanalysed = "src/api/index.ts";
  const quiet = "src/jobs/sendInviteEmail.ts";
  doc.triage.files = doc.triage.files.filter((f) => f.path !== unanalysed);
  doc.findings = doc.findings.filter((f) => f.path !== quiet);
  Object.assign(doc.provenance, {
    graphUnavailable: { reason: "too-large" },
    unanalysed: [{ path: unanalysed, reason: "timeout" }],
    readByHand: [{ path: quiet }],
  });
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
    {
      pull: pull(n.superseded),
      myReview: null,
      analysis: null,
      analysisRun: { status: "failed", code: "superseded" },
    },
  ];
};
