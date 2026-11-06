/**
 * A pull request's address in this app (H4-2): GitHub's shape, `/:owner/:repo/pull/:number`, so
 * swapping the host between github.com and Rocky opens the same PR. Names are checked against
 * GitHub's rules (the schema's) both ways; nothing is built from a name that fails them.
 */
import { limits, RepoName, RepoOwner } from "@rocky-reviews/schema";
import type { PullRef } from "../data/shell-data.js";

const PULL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]{0,9})\/?$/;

/** The PR an address names, when its names pass GitHub's rules; else `null`. */
export const pullRefFromPath = (pathname: string): PullRef | null => {
  const match = PULL_PATH.exec(pathname);
  if (match === null) return null;
  const owner = RepoOwner.safeParse(match[1]);
  const repo = RepoName.safeParse(match[2]);
  const number = Number(match[3]);
  if (!owner.success || !repo.success || [".", ".."].includes(repo.data)) return null;
  if (!Number.isSafeInteger(number) || number > limits.MAX_PR_NUMBER) return null;
  return { owner: owner.data, repo: repo.data, number };
};

/** A repository as the memory page's address names it (P8-3). */
export interface MemoryRef {
  readonly owner: string;
  readonly repo: string;
}

const MEMORY_PATH = /^\/([^/]+)\/([^/]+)\/memory\/?$/;

/** The repository a `/:owner/:repo/memory` address names, when its names pass GitHub's rules. */
export const memoryRefFromPath = (pathname: string): MemoryRef | null => {
  const match = MEMORY_PATH.exec(pathname);
  if (match === null) return null;
  const owner = RepoOwner.safeParse(match[1]);
  const repo = RepoName.safeParse(match[2]);
  if (!owner.success || !repo.success || [".", ".."].includes(repo.data)) return null;
  return { owner: owner.data, repo: repo.data };
};

/** The memory page of a repository in this app. */
export const memoryPagePath = (ref: MemoryRef): string =>
  `/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/memory`;

/** The review page of a PR in this app (the inbox links here). */
export const reviewPagePath = (ref: PullRef): string =>
  `/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/pull/${ref.number}`;
