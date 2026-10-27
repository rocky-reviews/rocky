/**
 * What the app shell (P6-1) renders, and the port it reads it through. The fixture source
 * (`fixture-source.ts`) implements it today; the server-backed source (P7-1, P6-2) replaces it
 * without the components changing.
 *
 * Everything here is untrusted PR content until `parseShellData` has checked it, and stays
 * untrusted text afterwards: components render it as text, never as HTML.
 */
import {
  type AnalysisDocument,
  GitRef,
  limits,
  parseAnalysisDocument,
  RepoName,
  RepoOwner,
} from "@rocky-reviews/schema";
import { z } from "zod";

/** A GitHub login, including app bots (`dependabot[bot]`). */
const Login = z
  .string()
  .max(limits.MAX_REPO_OWNER_LENGTH + 5)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9]))*(?:\[bot\])?$/, "must be a GitHub login");

/** GitHub caps titles at 256 characters; a little slack for other forges later. */
const MAX_TITLE_LENGTH = 1024;
const MAX_APPROVERS = 100;

/** What GitHub says about the PR (the mirror, ADR 0010). GitHub is the source of truth. */
export const PullSummary = z.strictObject({
  owner: RepoOwner,
  repo: RepoName,
  number: z.number().int().min(1).max(limits.MAX_PR_NUMBER),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  /** Null when GitHub reports no author (a deleted account shows as "ghost"). */
  author: Login.nullable(),
  state: z.enum(["open", "closed", "merged"]),
  headRef: GitRef,
  baseRef: GitRef,
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  changedFiles: z.number().int().min(0),
  updatedAt: z.iso.datetime(),
  /** Logins whose latest review on GitHub is an approval. */
  approvers: z.array(Login).max(MAX_APPROVERS),
  /** Review and issue comments already on the PR. */
  commentCount: z.number().int().min(0),
});
export type PullSummary = z.infer<typeof PullSummary>;

/** The viewer's own submitted review (set by Finish review, P6-6). */
export const MyReview = z.enum(["approved", "changes_requested", "commented"]);
export type MyReview = z.infer<typeof MyReview>;

export type ShellData = {
  pull: PullSummary;
  myReview: MyReview | null;
  /** Null while the analysis is queued, running or failed (P6-2 designs those states). */
  analysis: AnalysisDocument | null;
};

export type PullRef = Pick<PullSummary, "owner" | "repo" | "number">;

/** The port the shell reads through. */
export interface ShellDataSource {
  load(ref: PullRef): Promise<ShellData>;
}

export class ShellDataError extends Error {
  override readonly name = "ShellDataError";
}

/**
 * Validates data from any source. Error messages name the field, never its value: the value
 * is PR content.
 */
export const parseShellData = (input: {
  pull: unknown;
  myReview: unknown;
  analysis: unknown;
}): ShellData => {
  const pull = PullSummary.safeParse(input.pull);
  if (!pull.success)
    throw new ShellDataError(
      `invalid pull request summary: ${pull.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const myReview = MyReview.nullable().safeParse(input.myReview);
  if (!myReview.success) throw new ShellDataError("invalid review state");
  let analysis: AnalysisDocument | null = null;
  if (input.analysis !== null) {
    const parsed = parseAnalysisDocument(input.analysis);
    if (!parsed.ok) throw new ShellDataError(`invalid analysis document: ${parsed.error.code}`);
    analysis = parsed.value;
  }
  return { pull: pull.data, myReview: myReview.data, analysis };
};
