/**
 * The shell's data until the server serves it (P7-1, P6-2): the pr-847 analysis fixture from
 * packages/schema plus the GitHub-side facts the POC shows for that PR. It goes through the
 * same `parseShellData` a real source must use.
 */
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import {
  parseShellData,
  type PullRef,
  type ShellData,
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
  additions: 215,
  deletions: 3,
  changedFiles: 9,
  updatedAt: "2026-10-25T12:00:00.000Z",
  approvers: ["sam-r"],
  commentCount: 4,
} as const;

type Fixture = { pull: unknown; myReview: unknown; analysis: unknown };

const FIXTURES: readonly Fixture[] = [{ pull: PR_847_PULL, myReview: null, analysis: pr847 }];

const matches = (fixture: Fixture, ref: PullRef): boolean => {
  const pull = fixture.pull as Partial<PullRef>;
  return pull.owner === ref.owner && pull.repo === ref.repo && pull.number === ref.number;
};

export const createFixtureSource = (fixtures: readonly Fixture[] = FIXTURES): ShellDataSource => ({
  load: async (ref: PullRef): Promise<ShellData> => {
    const fixture = fixtures.find((f) => matches(f, ref));
    if (fixture === undefined) throw new ShellDataError("no such pull request");
    return parseShellData(fixture);
  },
});

export const DEFAULT_PULL: PullRef = { owner: "acme", repo: "rocky-app", number: 847 };
