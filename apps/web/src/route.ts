/**
 * Which page an address opens (H4-2). The app reads the server by default; the fixtures stay
 * available for development and the test suites behind an explicit switch.
 *
 *   /:owner/:repo/pull/:number    a pull request, from the server (GitHub's address shape)
 *   /inbox                        the inbox, from the server; `?source=fixture` for the fixture
 *   /?fixture=pr-847              the pr-847 fixture; also `?fixture=large-diff`, `?pr=<n>`
 *                                 (`&repo=<owner>/<name>`) and `?diff=newer-push` (P6-2…P6-5)
 *   /                             without a switch: the inbox
 *
 * Names in an address are checked against GitHub's rules (the schema's) before anything is
 * built from them; an address that cannot name a pull request is "not found".
 */
import { fixturePullFromSearch, newerPushFromSearch } from "./data/diff-fixture-source.js";
import type { PullRef } from "./data/shell-data.js";
import { pullRefFromPath } from "./lib/review-path.js";

export { pullRefFromPath, reviewPagePath } from "./lib/review-path.js";

export type Page =
  | { readonly kind: "inbox"; readonly source: "server" | "fixture" }
  | { readonly kind: "pull"; readonly source: "server"; readonly ref: PullRef }
  | {
      readonly kind: "pull";
      readonly source: "fixture";
      readonly ref: PullRef;
      readonly newerPush: boolean;
    }
  /** `/` without a fixture switch: the app sends the browser to the inbox. */
  | { readonly kind: "home" }
  | { readonly kind: "not_found" };

/** Query parameters that ask for a fixture PR page. */
const FIXTURE_PARAMS = ["fixture", "pr", "repo", "diff"] as const;

export const pageFor = (pathname: string, search: string): Page => {
  const params = new URLSearchParams(search);
  if (pathname === "/inbox" || pathname === "/inbox/")
    return { kind: "inbox", source: params.get("source") === "fixture" ? "fixture" : "server" };
  if (pathname === "/") {
    if (!FIXTURE_PARAMS.some((name) => params.has(name))) return { kind: "home" };
    return {
      kind: "pull",
      source: "fixture",
      ref: fixturePullFromSearch(search),
      newerPush: newerPushFromSearch(search),
    };
  }
  const ref = pullRefFromPath(pathname);
  return ref === null ? { kind: "not_found" } : { kind: "pull", source: "server", ref };
};
