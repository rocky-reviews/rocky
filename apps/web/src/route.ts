/**
 * Which page an address opens (H4-2). The app reads the server by default; the fixtures are
 * available only in development and test builds (`fixtures`, set in `main.tsx`), behind
 * an explicit switch:
 *
 *   /:owner/:repo/pull/:number    a pull request, from the server (GitHub's address shape)
 *   /inbox                        the inbox, from the server; `?source=fixture` for the fixture
 *   /:owner/:repo/memory          a repository's project memory (P8-3), from the server;
 *                                 `?source=fixture` (`&as=member` for a member's view)
 *   /?fixture=pr-847              the pr-847 fixture; also `?fixture=large-diff`, `?pr=<n>`
 *                                 (`&repo=<owner>/<name>`) and `?diff=newer-push` (P6-2…P6-5)
 *   /                             without a switch (or in production): the inbox
 *   /setup                        the setup wizard (P10-2), from the server
 *
 * Which fixture PR a fixture address names is read by `diff-fixture-source.ts`, loaded only
 * when fixtures are on, so production builds carry none of them. Names in an address are checked
 * against GitHub's rules (the schema's) before anything is built from them; an address that
 * cannot name a pull request is "not found".
 */
import type { PullRef } from "./data/shell-data.js";
import { memoryRefFromPath, pullRefFromPath, type MemoryRef } from "./lib/review-path.js";

export {
  memoryPagePath,
  memoryRefFromPath,
  pullRefFromPath,
  reviewPagePath,
} from "./lib/review-path.js";

export type Page =
  | { readonly kind: "inbox"; readonly source: "server" | "fixture" }
  | { readonly kind: "memory"; readonly source: "server"; readonly repo: MemoryRef }
  /** The fixture memory (development and tests); `canEdit: false` is a member's view. */
  | {
      readonly kind: "memory";
      readonly source: "fixture";
      readonly repo: MemoryRef;
      readonly canEdit: boolean;
    }
  | { readonly kind: "pull"; readonly source: "server"; readonly ref: PullRef }
  /** A fixture PR page; `search` says which (`fixturePullFromSearch`). */
  | { readonly kind: "pull"; readonly source: "fixture"; readonly search: string }
  /** `/` without a fixture switch: the app sends the browser to the inbox. */
  | { readonly kind: "home" }
  /** The setup wizard (P10-2); the server serves this page only while setup is open. */
  | { readonly kind: "setup" }
  | { readonly kind: "not_found" };

/** Query parameters that ask for a fixture PR page. */
const FIXTURE_PARAMS = ["fixture", "pr", "repo", "diff"] as const;

export const pageFor = (
  pathname: string,
  search: string,
  options: { readonly fixtures: boolean },
): Page => {
  const params = new URLSearchParams(search);
  const fixture = options.fixtures;
  if (pathname === "/setup" || pathname === "/setup/") return { kind: "setup" };
  if (pathname === "/inbox" || pathname === "/inbox/")
    return {
      kind: "inbox",
      source: fixture && params.get("source") === "fixture" ? "fixture" : "server",
    };
  if (pathname === "/") {
    if (!fixture || !FIXTURE_PARAMS.some((name) => params.has(name))) return { kind: "home" };
    return { kind: "pull", source: "fixture", search };
  }
  const memory = memoryRefFromPath(pathname);
  if (memory !== null)
    return fixture && params.get("source") === "fixture"
      ? { kind: "memory", source: "fixture", repo: memory, canEdit: params.get("as") !== "member" }
      : { kind: "memory", source: "server", repo: memory };
  const ref = pullRefFromPath(pathname);
  return ref === null ? { kind: "not_found" } : { kind: "pull", source: "server", ref };
};
