import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { describe, expect, it } from "vitest";
import { createFixtureSource, DEFAULT_PULL, PR_847_PULL } from "./fixture-source.js";
import { parseShellData, ShellDataError } from "./shell-data.js";

describe("fixture source", () => {
  it("serves pr-847 through the shell data port", async () => {
    const data = await createFixtureSource().load(DEFAULT_PULL);
    expect(data.pull).toMatchObject({ owner: "acme", repo: "rocky-app", number: 847 });
    expect(data.analysis?.provenance.pullRequest.number).toBe(847);
    expect(data.myReview).toBeNull();
  });

  it("agrees with the analysis on the PR's size and branches", async () => {
    const { pull, analysis } = await createFixtureSource().load(DEFAULT_PULL);
    const files = analysis?.provenance.files ?? [];
    expect(pull.changedFiles).toBe(files.length);
    expect(pull.additions).toBe(files.reduce((s, f) => s + f.additions, 0));
    expect(pull.deletions).toBe(files.reduce((s, f) => s + f.deletions, 0));
    expect(pull.headRef).toBe(analysis?.provenance.head.ref);
    expect(pull.baseRef).toBe(analysis?.provenance.base.ref);
  });

  it("refuses a PR it does not have", async () => {
    await expect(
      createFixtureSource().load({ owner: "acme", repo: "rocky-app", number: 1 }),
    ).rejects.toBeInstanceOf(ShellDataError);
  });
});

describe("parseShellData", () => {
  const valid = { pull: PR_847_PULL, myReview: null, analysis: pr847 };

  it("accepts a PR without an analysis yet", () => {
    expect(parseShellData({ ...valid, analysis: null }).analysis).toBeNull();
  });

  it("accepts bot logins", () => {
    const pull = { ...PR_847_PULL, author: "dependabot[bot]", approvers: ["renovate[bot]"] };
    expect(parseShellData({ ...valid, pull }).pull.author).toBe("dependabot[bot]");
  });

  it.each([
    ["owner", { owner: "evil.com/x" }],
    ["repo", { repo: "a b" }],
    ["number", { number: 0 }],
    ["title", { title: "" }],
    ["author", { author: "<img src=x>" }],
    ["headRef", { headRef: "a..b" }],
    ["updatedAt", { updatedAt: "yesterday" }],
    ["approvers", { approvers: ["ok", "not ok"] }],
    ["commentCount", { commentCount: -1 }],
    ["an unknown field", { url: "javascript:alert(1)" }],
  ])("refuses a bad %s without echoing it", (_name, patch) => {
    const pull = { ...PR_847_PULL, ...patch };
    let error: unknown;
    try {
      parseShellData({ ...valid, pull });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ShellDataError);
    for (const value of Object.values(patch)) {
      if (typeof value === "string" && value.length > 2)
        expect((error as Error).message).not.toContain(value);
    }
  });

  it("refuses an unknown review state", () => {
    expect(() => parseShellData({ ...valid, myReview: "merged" })).toThrow(ShellDataError);
  });

  it("refuses an invalid analysis document with its error code only", () => {
    expect(() => parseShellData({ ...valid, analysis: { schemaVersion: "1.1.0" } })).toThrow(
      /invalid analysis document: [A-Z_]+$/,
    );
  });
});
