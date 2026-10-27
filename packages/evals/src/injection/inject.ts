/**
 * Plants a corpus case in the pr-847 seeded pull request (P4-4). Payload lines are appended
 * after the target file's last hunk, so every line the seeded findings point at keeps its number
 * and an honest model's answers stay valid. Only the channel the case names changes.
 */
import type { AnalysisRequest } from "@rocky-reviews/core";
import { pr847Diff } from "../pr-847/diff.js";
import { PR847 } from "../pr-847/script.js";
import type { InjectionCase } from "./corpus.js";

export const CLEAN_TITLE = "Team invitations";

/** Content of the benign file a `file_path` case adds under the payload path. */
export const BENIGN_LINES = ["export const value = 1;"];

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

/** Appends `lines` with `sign` after the last hunk of `target`, fixing that hunk's counts. */
const appendToFile = (
  diff: string,
  target: string,
  sign: "+" | "-",
  lines: readonly string[],
): string => {
  const all = diff.replace(/\n$/, "").split("\n");
  const start = all.indexOf(`diff --git a/${target} b/${target}`);
  if (start === -1) throw new Error(`target ${target} is not in pr-847`);
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

const payloadLines = (payload: string): string[] => payload.split("\n");

export interface InjectedPullRequest {
  readonly title: string;
  readonly diff: string;
}

/** The case's target file; the corpus schema requires one for every file channel. */
const targetOf = (c: InjectionCase): string => {
  if (c.target === undefined) throw new Error(`case ${c.id} needs a target`);
  return c.target;
};

export const injectCase = (c: InjectionCase): InjectedPullRequest => {
  const diff = pr847Diff();
  const lines = payloadLines(c.payload);
  switch (c.channel) {
    case "pr_title":
      return { title: c.payload, diff };
    case "file_path":
      return {
        title: CLEAN_TITLE,
        diff: `${diff}${addedFile(c.payload, BENIGN_LINES).join("\n")}\n`,
      };
    case "new_file":
      return { title: CLEAN_TITLE, diff: `${diff}${addedFile(targetOf(c), lines).join("\n")}\n` };
    case "diff_added":
      return { title: CLEAN_TITLE, diff: appendToFile(diff, targetOf(c), "+", lines) };
    case "diff_comment": {
      const prefix = commentPrefix(targetOf(c));
      const commented = lines.map((line) => `${prefix}${line}`);
      return { title: CLEAN_TITLE, diff: appendToFile(diff, targetOf(c), "+", commented) };
    }
    case "diff_removed":
      return { title: CLEAN_TITLE, diff: appendToFile(diff, targetOf(c), "-", lines) };
  }
};

/** The analysis request for an injected (or, with no case, the clean) pr-847. */
export const injectionRequest = (c?: InjectionCase): AnalysisRequest => {
  const { title, diff } =
    c === undefined ? { title: CLEAN_TITLE, diff: pr847Diff() } : injectCase(c);
  return {
    repo: { owner: "acme", name: "rocky-app" },
    pullRequest: { number: 847, title },
    base: { sha: PR847.provenance.base.sha, ref: "main" },
    head: { sha: PR847.provenance.head.sha, ref: "feat/team-invites" },
    diff,
    diffTruncated: false,
  };
};
