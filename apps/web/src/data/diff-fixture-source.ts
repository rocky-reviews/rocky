/**
 * The diff until the server serves it (after P7-1 and P7-2): pr-847's unified diff (the evals
 * package's copy, which reproduces the analysis fixture's facts) and the generated 5,000-line
 * diff. Like any source it returns unchecked data; the view runs it through `parseDiffData`.
 */
import { pr847Diff } from "@rocky-reviews/evals/pr-847/diff";
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

/** Which fixture PR the page shows: pr-847, or the large diff with `?fixture=large-diff`. */
export const fixturePullFromSearch = (search: string): PullRef =>
  new URLSearchParams(search).get("fixture") === "large-diff" ? LARGE_PULL : DEFAULT_PULL;
