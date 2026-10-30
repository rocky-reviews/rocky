import { describe, expect, it } from "vitest";
import { fixturePullFromSearch, newerPushFromSearch } from "./data/diff-fixture-source.js";
import { DEFAULT_PULL } from "./data/fixture-source.js";
import { pageFor, pullRefFromPath, reviewPagePath } from "./route.js";

const ON = { fixtures: true };

describe("pageFor (H4-2): the server by default, fixtures behind an explicit switch", () => {
  it("a real PR address reads the server", () => {
    expect(pageFor("/acme/rocky-app/pull/847", "", ON)).toEqual({
      kind: "pull",
      source: "server",
      ref: { owner: "acme", repo: "rocky-app", number: 847 },
    });
    expect(pageFor("/acme/rocky-app/pull/847/", "?fixture=pr-847", ON)).toMatchObject({
      source: "server",
    });
  });

  it("the inbox reads the server unless `?source=fixture`", () => {
    expect(pageFor("/inbox", "", ON)).toEqual({ kind: "inbox", source: "server" });
    expect(pageFor("/inbox", "?source=api", ON)).toEqual({ kind: "inbox", source: "server" });
    expect(pageFor("/inbox/", "?source=fixture", ON)).toEqual({ kind: "inbox", source: "fixture" });
  });

  it("`/` opens a fixture only when asked; otherwise it is the inbox", () => {
    expect(pageFor("/", "", ON)).toEqual({ kind: "home" });
    expect(pageFor("/", "?utm=x", ON)).toEqual({ kind: "home" });
    for (const search of ["?fixture=pr-847", "?pr=2", "?fixture=large-diff", "?diff=newer-push"])
      expect(pageFor("/", search, ON), search).toEqual({ kind: "pull", source: "fixture", search });
  });

  it("review S2: production refuses every fixture switch", () => {
    const OFF = { fixtures: false };
    for (const search of [
      "?fixture=pr-847",
      "?pr=2",
      "?repo=acme/rocky-app&pr=847",
      "?fixture=large-diff",
      "?diff=newer-push",
    ])
      expect(pageFor("/", search, OFF), search).toEqual({ kind: "home" });
    expect(pageFor("/inbox", "?source=fixture", OFF)).toEqual({ kind: "inbox", source: "server" });
    expect(pageFor("/acme/rocky-app/pull/847", "?fixture=pr-847", OFF)).toMatchObject({
      source: "server",
    });
  });

  it("the fixture address names the fixture PR (diff-fixture-source)", () => {
    expect(fixturePullFromSearch("?fixture=pr-847")).toEqual(DEFAULT_PULL);
    expect(fixturePullFromSearch("?pr=2")).toMatchObject({ number: 2 });
    expect(fixturePullFromSearch("?fixture=large-diff")).toMatchObject({ number: 5000 });
    expect(newerPushFromSearch("?diff=newer-push")).toBe(true);
  });

  it("anything else is not found", () => {
    for (const path of [
      "/acme",
      "/acme/rocky-app",
      "/acme/rocky-app/pull",
      "/acme/rocky-app/pull/0",
      "/acme/rocky-app/pull/01",
      "/acme/rocky-app/pull/1x",
      "/acme/rocky-app/pulls/1",
      "/acme/rocky-app/pull/1/files",
      "/acme/../pull/1",
      "/acme/./pull/1",
      "/-acme/rocky-app/pull/1",
      "/ac%20me/rocky-app/pull/1",
      "/acme/rocky%2Fapp/pull/1",
      "/acme/rocky-app/pull/9999999999",
      "//evil.example/x/pull/1",
    ]) {
      expect(pageFor(path, "", ON), path).toEqual({ kind: "not_found" });
    }
  });
});

describe("review page addresses", () => {
  it("round-trips a PR through its address", () => {
    const ref = { owner: "acme", repo: "rocky.app_2", number: 12 };
    expect(reviewPagePath(ref)).toBe("/acme/rocky.app_2/pull/12");
    expect(pullRefFromPath(reviewPagePath(ref))).toEqual(ref);
  });
});
