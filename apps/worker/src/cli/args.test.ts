import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS, parseCliArgs, UsageError } from "./args.js";

/** P4-8: `pnpm rocky analyze <owner/repo>#<n>` arguments. */

describe("parseCliArgs", () => {
  it("takes owner/repo#n with the conservative default cap", () => {
    expect(parseCliArgs(["analyze", "rocky-reviews/rocky#20"])).toEqual({
      command: "analyze",
      owner: "rocky-reviews",
      name: "rocky",
      fullName: "rocky-reviews/rocky",
      number: 20,
      maxTokens: DEFAULT_MAX_TOKENS,
      dryRun: false,
      json: false,
    });
  });

  it("takes --max-tokens (both spellings), --dry-run, --json, and pnpm's leading --", () => {
    expect(
      parseCliArgs(["--", "analyze", "acme/api.js#7", "--max-tokens", "1000", "--dry-run"]),
    ).toMatchObject({ fullName: "acme/api.js", number: 7, maxTokens: 1000, dryRun: true });
    expect(parseCliArgs(["analyze", "--json", "--max-tokens=250000", "acme/api#1"])).toMatchObject({
      maxTokens: 250_000,
      json: true,
      dryRun: false,
    });
  });

  it("answers help", () => {
    expect(parseCliArgs([])).toEqual({ command: "help" });
    expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
    expect(parseCliArgs(["analyze", "-h"])).toEqual({ command: "help" });
  });

  it("refuses anything else with the usage line", () => {
    for (const argv of [
      ["post", "acme/api#1"],
      ["analyze"],
      ["analyze", "acme/api"],
      ["analyze", "acme/api#"],
      ["analyze", "acme/api#0"],
      ["analyze", "acme/api#01"],
      ["analyze", "acme/api#1.5"],
      ["analyze", "acme#1"],
      ["analyze", "../etc/passwd#1"],
      ["analyze", "acme/api#1", "acme/web#2"],
      ["analyze", "acme/api#1", "--max-tokens"],
      ["analyze", "acme/api#1", "--max-tokens", "0"],
      ["analyze", "acme/api#1", "--max-tokens", "-5"],
      ["analyze", "acme/api#1", "--max-tokens", "1e6"],
      ["analyze", "acme/api#1", "--max-tokens", String(MAX_MAX_TOKENS + 1)],
      ["analyze", "acme/api#1", "--post"],
    ]) {
      expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(UsageError);
      expect(() => parseCliArgs(argv), argv.join(" ")).toThrow(/usage: pnpm rocky analyze/);
    }
  });

  it("never echoes an argument back (it could be anything pasted)", () => {
    try {
      parseCliArgs(["analyze", "acme/api#1", "--sk-ant-secret-looking"]);
    } catch (error) {
      expect((error as Error).message).not.toContain("sk-ant");
      return;
    }
    throw new Error("expected a UsageError");
  });
});
