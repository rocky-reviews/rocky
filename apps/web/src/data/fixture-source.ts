/**
 * The shell's data until the server serves it (P7-1, P6-2): the pr-847 analysis fixture from
 * packages/schema plus the GitHub-side facts the POC shows for that PR. Like any source it
 * returns unchecked parts; the app runs them through `parseShellData`.
 */
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { briefingFixtures } from "../briefing/fixtures.js";
import { largeShellData } from "./large-fixture.js";
import {
  type PullRef,
  type RawShellData,
  ShellDataError,
  type ShellDataSource,
} from "./shell-data.js";

/** GitHub's view of pr-847 (the POC's PR). Totals match the fixture's provenance. */
export const PR_847_PULL = {
  owner: "acme",
  repo: "rocky-app",
  number: 847,
  title: "Team invitations with expiring links",
  author: "dana-k",
  state: "open",
  headRef: "feat/team-invites",
  baseRef: "main",
  headSha: "9b4e1d7a3c5f2e8b6d0a4c7e1f3b5d9a2c6e8f4b",
  additions: 215,
  deletions: 3,
  changedFiles: 9,
  updatedAt: "2026-10-25T12:00:00.000Z",
  approvers: ["sam-r"],
  commentCount: 4,
} as const;

const FIXTURES: readonly RawShellData[] = [
  { pull: PR_847_PULL, myReview: null, analysis: pr847 },
  // P6-3: a 5,000-line diff for the performance trace (`?fixture=large-diff`).
  largeShellData(),
  // The briefing's empty and failed states (P6-2).
  ...briefingFixtures(PR_847_PULL),
];

const matches = (fixture: RawShellData, ref: PullRef): boolean => {
  const pull = fixture.pull as Partial<PullRef>;
  return pull.owner === ref.owner && pull.repo === ref.repo && pull.number === ref.number;
};

/**
 * A stable analysis id per fixture PR (P6-4: the drafts API is keyed by it), as the server's
 * shell data will carry the row's id: `00000000-0000-4000-8000-<PR number>`.
 */
export const fixtureAnalysisId = (number: number): string =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

export const createFixtureSource = (
  fixtures: readonly RawShellData[] = FIXTURES,
): ShellDataSource => ({
  load: async (ref: PullRef): Promise<RawShellData> => {
    const fixture = fixtures.find((f) => matches(f, ref));
    if (fixture === undefined) throw new ShellDataError("no such pull request");
    if (fixture.analysis === null || fixture.analysisId !== undefined) return fixture;
    return { ...fixture, analysisId: fixtureAnalysisId(ref.number) };
  },
});

export const DEFAULT_PULL: PullRef = { owner: "acme", repo: "rocky-app", number: 847 };
