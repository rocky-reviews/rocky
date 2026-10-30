import { describe, expect, it } from "vitest";
import { fixturePullFromSearch } from "./diff-fixture-source.js";
import { DEFAULT_PULL } from "./fixture-source.js";
import { LARGE_PULL } from "./large-fixture.js";

describe("fixturePullFromSearch", () => {
  it("defaults to pr-847 and opens the large diff", () => {
    expect(fixturePullFromSearch("")).toEqual(DEFAULT_PULL);
    expect(fixturePullFromSearch("?fixture=large-diff")).toEqual(LARGE_PULL);
  });

  it("reads a PR number, and a repository from the inbox's links (P6-7)", () => {
    expect(fixturePullFromSearch("?pr=851")).toEqual({ ...DEFAULT_PULL, number: 851 });
    expect(fixturePullFromSearch("?repo=acme%2Fbilling&pr=312")).toEqual({
      owner: "acme",
      repo: "billing",
      number: 312,
    });
  });

  it("ignores a repository that fails GitHub's rules, and a repository without a number", () => {
    for (const repo of ["acme/..", "acme/a/b", "-x/y", "acme", "acme/a%20b", "../etc"]) {
      expect(fixturePullFromSearch(`?repo=${encodeURIComponent(repo)}&pr=3`)).toEqual({
        ...DEFAULT_PULL,
        number: 3,
      });
    }
    expect(fixturePullFromSearch("?repo=acme%2Fbilling")).toEqual(DEFAULT_PULL);
  });
});
