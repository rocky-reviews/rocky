import { parseUnifiedDiff } from "@rocky-reviews/core/diff";
import { describe, expect, it } from "vitest";
import { createFixtureSource } from "./fixture-source.js";
import { LARGE_PATH, LARGE_PULL, largeDiff } from "./large-fixture.js";
import { parseShellData } from "./shell-data.js";

describe("large-diff fixture (P6-3 performance)", () => {
  it("is a valid PR whose analysis describes exactly the generated diff", async () => {
    const data = parseShellData(await createFixtureSource().load(LARGE_PULL));
    const diff = parseUnifiedDiff(largeDiff());
    if (!diff.ok) throw new Error(diff.code);
    const [file] = diff.files;
    const [described] = data.analysis!.provenance.files;
    expect(file?.path).toBe(LARGE_PATH);
    expect(described).toMatchObject({
      path: file?.path,
      status: file?.status,
      additions: file?.additions,
      deletions: file?.deletions,
      hunks: file?.hunks,
    });
    expect(data.pull.additions).toBe(file?.additions);
    expect(data.pull.deletions).toBe(file?.deletions);
  });

  it("has AI flags and a finding spread through the file, so hot lines are exercised", async () => {
    const data = parseShellData(await createFixtureSource().load(LARGE_PULL));
    const [triaged] = data.analysis!.triage.files;
    expect(triaged?.flags.length).toBeGreaterThanOrEqual(10);
    expect(new Set(triaged?.flags.map((f) => f.kind))).toEqual(new Set(["look", "question", "ok"]));
    expect(data.analysis!.findings.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(largeDiff()).toBe(largeDiff());
  });
});
