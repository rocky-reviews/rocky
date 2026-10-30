import pr847 from "@rocky-reviews/schema/fixtures/pr-847.json";
import { describe, expect, it } from "vitest";
import { createFixtureSource, DEFAULT_PULL, PR_847_PULL } from "./fixture-source.js";
import { parseShellData, ShellDataError } from "./shell-data.js";

describe("fixture source", () => {
  it("serves pr-847 through the shell data port", async () => {
    const data = parseShellData(await createFixtureSource().load(DEFAULT_PULL));
    expect(data.pull).toMatchObject({ owner: "acme", repo: "rocky-app", number: 847 });
    expect(data.analysis?.provenance.pullRequest.number).toBe(847);
    expect(data.myReview).toBeNull();
  });

  it("agrees with the analysis on the PR's size and branches", async () => {
    const { pull, analysis } = parseShellData(await createFixtureSource().load(DEFAULT_PULL));
    const files = analysis?.provenance.files ?? [];
    expect(pull.changedFiles).toBe(files.length);
    expect(pull.additions).toBe(files.reduce((s, f) => s + f.additions, 0));
    expect(pull.deletions).toBe(files.reduce((s, f) => s + f.deletions, 0));
    expect(pull.headRef).toBe(analysis?.provenance.head.ref);
    expect(pull.headSha).toBe(analysis?.provenance.head.sha);
    expect(pull.baseRef).toBe(analysis?.provenance.base.ref);
  });

  it("refuses a PR it does not have", async () => {
    await expect(
      createFixtureSource().load({ owner: "acme", repo: "rocky-app", number: 1 }),
    ).rejects.toBeInstanceOf(ShellDataError);
  });
});

describe("parseShellData", () => {
  const ID = "6f1c2a9e-1d4b-4c3e-9a7f-0b2d4e6f8a1c";
  const valid = { pull: PR_847_PULL, myReview: null, analysis: pr847, analysisId: ID };

  it("accepts a PR without an analysis yet", () => {
    expect(parseShellData({ ...valid, analysis: null }).analysis).toBeNull();
  });

  it("carries the analysis id the drafts are keyed by (P6-4), and requires it with a document", () => {
    expect(parseShellData(valid).analysisId).toBe(ID);
    expect(parseShellData({ ...valid, analysisId: ID.toUpperCase() }).analysisId).toBe(ID);
    expect(parseShellData({ ...valid, analysis: null }).analysisId).toBeNull();
    for (const analysisId of [undefined, null, "", "../x", 7, `${ID} `]) {
      expect(() => parseShellData({ ...valid, analysisId })).toThrow("invalid analysis id");
    }
  });

  it("the fixture source gives each fixture PR with a document a stable analysis id", async () => {
    const data = parseShellData(await createFixtureSource().load(DEFAULT_PULL));
    expect(data.analysisId).toBe("00000000-0000-4000-8000-000000000847");
  });

  it.each(["john--doe", "foo-", "-legacy", "a"])(
    "accepts the legacy login %s as author and approver",
    (login) => {
      const pull = { ...PR_847_PULL, author: login, approvers: [login] };
      expect(parseShellData({ ...valid, pull }).pull.approvers).toEqual([login]);
    },
  );

  it.each(["a".repeat(40), "a b", "a/b", "dependabot[bot][bot]", ""])(
    "refuses %j as a login",
    (login) => {
      expect(() => parseShellData({ ...valid, pull: { ...PR_847_PULL, author: login } })).toThrow(
        ShellDataError,
      );
    },
  );

  it("keeps owner and repo strict", () => {
    expect(() => parseShellData({ ...valid, pull: { ...PR_847_PULL, owner: "foo-" } })).toThrow(
      ShellDataError,
    );
  });

  it.each([
    ["owner", { owner: "other" }],
    ["repo", { repo: "other-app" }],
    ["number", { number: 848 }],
  ])("refuses an analysis of another PR (%s differs)", (_name, patch) => {
    expect(() => parseShellData({ ...valid, pull: { ...PR_847_PULL, ...patch } })).toThrow(
      new ShellDataError("analysis does not match pull request"),
    );
  });

  it("matches owner and repo case-insensitively, as GitHub does", () => {
    const pull = { ...PR_847_PULL, owner: "ACME", repo: "Rocky-App" };
    expect(parseShellData({ ...valid, pull }).analysis).not.toBeNull();
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
    ["headSha", { headSha: "9b4e1d7" }],
    ["headSha case", { headSha: "9B4E1D7A3C5F2E8B6D0A4C7E1F3B5D9A2C6E8F4B" }],
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
