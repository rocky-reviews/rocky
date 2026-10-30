import { describe, expect, it } from "vitest";
import { DEFAULT_PULL } from "./data/fixture-source.js";
import { pageFor, pullRefFromPath, reviewPagePath } from "./route.js";

describe("pageFor (H4-2): the server by default, fixtures behind an explicit switch", () => {
  it("a real PR address reads the server", () => {
    expect(pageFor("/acme/rocky-app/pull/847", "")).toEqual({
      kind: "pull",
      source: "server",
      ref: { owner: "acme", repo: "rocky-app", number: 847 },
    });
    expect(pageFor("/acme/rocky-app/pull/847/", "?fixture=pr-847")).toMatchObject({
      source: "server",
    });
  });

  it("the inbox reads the server unless `?source=fixture`", () => {
    expect(pageFor("/inbox", "")).toEqual({ kind: "inbox", source: "server" });
    expect(pageFor("/inbox", "?source=api")).toEqual({ kind: "inbox", source: "server" });
    expect(pageFor("/inbox/", "?source=fixture")).toEqual({ kind: "inbox", source: "fixture" });
  });

  it("`/` opens a fixture only when asked; otherwise it is the inbox", () => {
    expect(pageFor("/", "")).toEqual({ kind: "home" });
    expect(pageFor("/", "?utm=x")).toEqual({ kind: "home" });
    expect(pageFor("/", "?fixture=pr-847")).toEqual({
      kind: "pull",
      source: "fixture",
      ref: DEFAULT_PULL,
      newerPush: false,
    });
    expect(pageFor("/", "?pr=2")).toMatchObject({ source: "fixture", ref: { number: 2 } });
    expect(pageFor("/", "?fixture=large-diff")).toMatchObject({
      source: "fixture",
      ref: { number: 5000 },
    });
    expect(pageFor("/", "?diff=newer-push")).toMatchObject({
      source: "fixture",
      ref: DEFAULT_PULL,
      newerPush: true,
    });
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
      expect(pageFor(path, ""), path).toEqual({ kind: "not_found" });
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
