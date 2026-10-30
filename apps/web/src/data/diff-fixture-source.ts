/**
 * The diff until the server serves it (after P7-1 and P7-2): pr-847's unified diff (the evals
 * package's copy, which reproduces the analysis fixture's facts) and the generated 5,000-line
 * diff. Like any source it returns unchecked data; the view runs it through `parseDiffData`.
 */
import { pr847Diff } from "@rocky-reviews/evals/pr-847/diff";
import { RepoName, RepoOwner } from "@rocky-reviews/schema";
import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { DiffDataError, type DiffDataSource, type RawDiffData } from "./diff-data.js";
import { DEFAULT_PULL } from "./fixture-source.js";
import { LARGE_HEAD_SHA, LARGE_PULL, largeDiff } from "./large-fixture.js";
import type { PullRef } from "./shell-data.js";

const same = (a: PullRef, b: PullRef) =>
  a.owner === b.owner && a.repo === b.repo && a.number === b.number;

const FIXTURES: readonly { ref: PullRef; load: () => RawDiffData }[] = [
  { ref: DEFAULT_PULL, load: () => ({ headSha: pr847.provenance.head.sha, diff: pr847Diff() }) },
  { ref: LARGE_PULL, load: () => ({ headSha: LARGE_HEAD_SHA, diff: largeDiff() }) },
];

export const createFixtureDiffSource = (): DiffDataSource => ({
  load: async (ref: PullRef): Promise<RawDiffData> => {
    const fixture = FIXTURES.find((f) => same(f.ref, ref));
    if (fixture === undefined) throw new DiffDataError("no such pull request");
    return fixture.load();
  },
});

/**
 * Which fixture PR the page shows: the large diff with `?fixture=large-diff`, a briefing fixture
 * PR with `?pr=<number>` (P6-2), otherwise pr-847. `?repo=<owner>/<name>` (the inbox's links,
 * P6-7) names the repository; a name that fails GitHub's rules is ignored.
 */
export const fixturePullFromSearch = (search: string): PullRef => {
  const params = new URLSearchParams(search);
  if (params.get("fixture") === "large-diff") return LARGE_PULL;
  const [owner, repo, extra] = (params.get("repo") ?? "").split("/");
  const ownerOk = RepoOwner.safeParse(owner);
  const repoOk = RepoName.safeParse(repo);
  const named =
    extra === undefined && ownerOk.success && repoOk.success && ![".", ".."].includes(repoOk.data)
      ? { owner: ownerOk.data, repo: repoOk.data }
      : { owner: DEFAULT_PULL.owner, repo: DEFAULT_PULL.repo };
  const requested = Number(params.get("pr"));
  return Number.isSafeInteger(requested) && requested > 0
    ? { ...named, number: requested }
    : DEFAULT_PULL;
};
