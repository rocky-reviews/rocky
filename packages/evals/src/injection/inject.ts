/**
 * Plants a corpus case in a seeded pull request (P4-4). Payload lines are appended after the
 * target file's last hunk, so every line the seeded findings point at keeps its number and an
 * honest model's answers stay valid. Only the channel the case names changes.
 *
 * Two fixtures (review round 1, item 2): pr-847, whose honest verdict equals its findings' floor
 * (critical), and pr-912, whose honest verdict (high) sits above it and is held by a critical
 * triage. Corpus targets name pr-847 files; a fixture maps them to its file in the same role.
 */
import type { AnalysisRequest } from "@rocky-reviews/core";
import type { ScriptedAnswer, ScriptedCall } from "@rocky-reviews/core/testing";
import { pr847Diff } from "../pr-847/diff.js";
import { PR847, pr847Script } from "../pr-847/script.js";
import {
  PR912_BASE,
  PR912_HEAD,
  PR912_TARGETS,
  PR912_TITLE,
  pr912Diff,
  pr912Script,
} from "../pr-912/fixture.js";
import type { InjectionCase } from "./corpus.js";

export interface InjectionFixture {
  readonly name: "pr-847" | "pr-912";
  readonly title: string;
  readonly number: number;
  readonly base: string;
  readonly head: string;
  readonly diff: () => string;
  /** The fixture's file for a corpus target (named after pr-847's files). */
  readonly target: (target: string) => string;
  /** The fixture's own files. */
  readonly paths: ReadonlySet<string>;
  /** Answers like a good model for the fixture's own files; ignores any payload. */
  readonly script: (call: ScriptedCall) => ScriptedAnswer;
}

export const PR847_FIXTURE: InjectionFixture = {
  name: "pr-847",
  title: "Team invitations",
  number: 847,
  base: PR847.provenance.base.sha,
  head: PR847.provenance.head.sha,
  diff: () => pr847Diff(),
  target: (target) => target,
  paths: new Set(PR847.provenance.files.map((file) => file.path)),
  script: pr847Script,
};

export const PR912_FIXTURE: InjectionFixture = {
  name: "pr-912",
  title: PR912_TITLE,
  number: 912,
  base: PR912_BASE,
  head: PR912_HEAD,
  diff: pr912Diff,
  target: (target) => PR912_TARGETS[target] ?? target,
  paths: new Set(Object.values(PR912_TARGETS)),
  script: pr912Script,
};

export const INJECTION_FIXTURES: readonly InjectionFixture[] = [PR847_FIXTURE, PR912_FIXTURE];

export const CLEAN_TITLE = PR847_FIXTURE.title;

/** Content of the benign file a `file_path` case adds under the payload path. */
export const BENIGN_LINES = ["export const value = 1;"];
/** Where a `rename_from` case moves its payload-named file. */
export const RENAMED_TO = "src/util/renamed.ts";

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

const commentPrefix = (path: string): string => {
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) return "// ";
  if (path.endsWith(".sql")) return "-- ";
  if (path.endsWith(".md")) return "";
  return "# ";
};

const addedFile = (path: string, lines: readonly string[]): string[] => [
  `diff --git a/${path} b/${path}`,
  "new file mode 100644",
  "--- /dev/null",
  `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`,
  ...lines.map((line) => `+${line}`),
];

/** A rename with one changed line: the old path travels in the patch's header lines. */
const renamedFile = (from: string, to: string): string[] => [
  `diff --git a/${from} b/${to}`,
  "similarity index 90%",
  `rename from ${from}`,
  `rename to ${to}`,
  "index 1111111..2222222 100644",
  `--- a/${from}`,
  `+++ b/${to}`,
  "@@ -1,2 +1,2 @@",
  " export const value = 1;",
  '-export const name = "old";',
  '+export const name = "new";',
];

/** Appends `lines` with `sign` after the last hunk of `target`, fixing that hunk's counts. */
const appendToFile = (
  diff: string,
  target: string,
  sign: "+" | "-",
  lines: readonly string[],
): string => {
  const all = diff.replace(/\n$/, "").split("\n");
  const start = all.indexOf(`diff --git a/${target} b/${target}`);
  if (start === -1) throw new Error(`target ${target} is not in the fixture`);
  let end = all.findIndex((line, index) => index > start && line.startsWith("diff --git "));
  if (end === -1) end = all.length;
  let header = -1;
  for (let index = start; index < end; index++) if (all[index]?.startsWith("@@ ")) header = index;
  const match = HUNK.exec(all[header] ?? "");
  if (match === null) throw new Error(`target ${target} has no hunk`);
  const [, oldStart, oldLines = "1", newStart, newLines = "1", tail] = match;
  const k = lines.length;
  const oldCount = Number(oldLines) + (sign === "-" ? k : 0);
  const newCount = Number(newLines) + (sign === "+" ? k : 0);
  all[header] = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${tail}`;
  all.splice(end, 0, ...lines.map((line) => `${sign}${line}`));
  return `${all.join("\n")}\n`;
};

export interface InjectedPullRequest {
  readonly title: string;
  readonly diff: string;
}

/** The case's target file; the corpus schema requires one for every file channel. */
const targetOf = (c: InjectionCase, fixture: InjectionFixture): string => {
  if (c.target === undefined) throw new Error(`case ${c.id} needs a target`);
  return fixture.target(c.target);
};

export const injectCase = (
  c: InjectionCase,
  fixture: InjectionFixture = PR847_FIXTURE,
): InjectedPullRequest => {
  const diff = fixture.diff();
  const lines = c.payload.split("\n");
  const title = fixture.title;
  switch (c.channel) {
    case "pr_title":
      return { title: c.payload, diff };
    case "file_path":
      return { title, diff: `${diff}${addedFile(c.payload, BENIGN_LINES).join("\n")}\n` };
    case "rename_from":
      return { title, diff: `${diff}${renamedFile(c.payload, RENAMED_TO).join("\n")}\n` };
    case "new_file":
      return { title, diff: `${diff}${addedFile(targetOf(c, fixture), lines).join("\n")}\n` };
    case "diff_added":
      return { title, diff: appendToFile(diff, targetOf(c, fixture), "+", lines) };
    case "diff_comment": {
      const target = targetOf(c, fixture);
      const prefix = commentPrefix(target);
      const commented = lines.map((line) => `${prefix}${line}`);
      return { title, diff: appendToFile(diff, target, "+", commented) };
    }
    case "diff_removed":
      return { title, diff: appendToFile(diff, targetOf(c, fixture), "-", lines) };
  }
};

/** The analysis request for an injected (or, with no case, the clean) fixture. */
export const injectionRequest = (
  c?: InjectionCase,
  fixture: InjectionFixture = PR847_FIXTURE,
): AnalysisRequest => {
  const { title, diff } =
    c === undefined ? { title: fixture.title, diff: fixture.diff() } : injectCase(c, fixture);
  return {
    repo: { owner: "acme", name: "rocky-app" },
    pullRequest: { number: fixture.number, title },
    base: { sha: fixture.base, ref: "main" },
    head: { sha: fixture.head, ref: "feat/seeded" },
    diff,
    diffTruncated: false,
  };
};
