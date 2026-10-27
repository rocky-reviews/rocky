/**
 * The "View on GitHub" link. Built only from an owner, repository and number that pass the
 * schema's GitHub rules, never from a URL the data carries, so PR content cannot point the link
 * anywhere else (a `javascript:` URL, a look-alike host, a path outside the PR).
 */
import { limits, RepoName, RepoOwner } from "@rocky-reviews/schema";
import type { PullRef } from "../data/shell-data.js";

const GITHUB = "https://github.com";

export const pullRequestUrl = (ref: PullRef): string | undefined => {
  const owner = RepoOwner.safeParse(ref.owner);
  const repo = RepoName.safeParse(ref.repo);
  const valid =
    owner.success &&
    repo.success &&
    // "." and ".." match the name pattern but would walk the path.
    repo.data !== "." &&
    repo.data !== ".." &&
    Number.isSafeInteger(ref.number) &&
    ref.number >= 1 &&
    ref.number <= limits.MAX_PR_NUMBER;
  if (!valid) return undefined;
  const url = new URL(
    `/${encodeURIComponent(owner.data)}/${encodeURIComponent(repo.data)}/pull/${ref.number}`,
    GITHUB,
  );
  return url.href;
};
