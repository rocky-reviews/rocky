import {
  ForgeReadError,
  type ForgeDiff,
  type ForgePullRequest,
  type RepositoryRef,
  type RepositorySession,
  type RevisionRef,
} from "@rocky-reviews/core";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createPullRequestDiffReader,
  DIFF_CACHE_MAX_BYTES,
  DIFF_CACHE_MAX_ENTRIES,
  DIFF_CACHE_TTL_MS,
  PULL_REQUEST_DIFF_MAX_BYTES,
  type PullRequestDiffResult,
  type PullRequestDiffTarget,
  wholeFiles,
} from "./diff-reader.js";

/**
 * H4-3 (ADR 0034): the on-demand diff reader behind `GET …/pulls/:number/diff`. One read-only
 * repository session per read (the mirror's, ADR 0010 §2), the pull request's head verified
 * against the mirror's before the diff is read, the same 1 MiB cap as the mirror, and a short,
 * bounded in-memory cache per org + repository + revision that never holds a failure.
 */

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const ORG = "6f1c2a9e-1d4b-4c3e-9a7f-0b2d4e6f8a1c";
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

const target = (overrides: Partial<PullRequestDiffTarget> = {}): PullRequestDiffTarget => ({
  orgId: ORG,
  installationId: 181,
  repositoryId: 5001,
  number: 847,
  headSha: HEAD,
  baseSha: BASE,
  ...overrides,
});

const reading = (bytes: Uint8Array, truncation: ForgeDiff["truncation"]): ForgeDiff => ({
  bytes,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  truncated: truncation !== null,
  truncation,
});

type Calls = {
  opened: RepositoryRef[];
  pulls: number[];
  diffs: { revision: RevisionRef; maxBytes: number }[];
  closed: number;
};

/** A forge whose one repository session answers from these settings. */
const fakeForge = (
  options: {
    pull?: Partial<ForgePullRequest> | null | Error;
    /** GitHub's head per pull request number (default: `HEAD` for every number). */
    heads?: Record<number, string>;
    diff?: ForgeDiff | Error;
    open?: "null" | Error;
    /** Called when a session opens; resolves the session's answers after it. */
    gate?: () => Promise<void>;
  } = {},
) => {
  const calls: Calls = { opened: [], pulls: [], diffs: [], closed: 0 };
  const forge = {
    openRepository: async (ref: RepositoryRef): Promise<RepositorySession | null> => {
      calls.opened.push(ref);
      if (options.open === "null") return null;
      if (options.open instanceof Error) throw options.open;
      await options.gate?.();
      const session: RepositorySession = {
        repository: {
          id: ref.repositoryId,
          fullName: "acme/rocky-app",
          private: true,
          defaultBranch: "main",
        },
        getPullRequest: async (number) => {
          calls.pulls.push(number);
          if (options.pull === null) return null;
          if (options.pull instanceof Error) throw options.pull;
          return {
            ref: { ...ref, number },
            title: "t",
            authorLogin: null,
            state: "open",
            headSha: options.heads?.[number] ?? HEAD,
            baseSha: BASE,
            openedAt: new Date(0),
            closedAt: null,
            updatedAt: new Date(0),
            changedFiles: 1,
            additions: 1,
            deletions: 1,
            ...options.pull,
          };
        },
        listPullRequests: async function* () {},
        getDiff: async (revision, { maxBytes }) => {
          calls.diffs.push({ revision, maxBytes });
          if (options.diff instanceof Error) throw options.diff;
          return options.diff ?? reading(Buffer.from(DIFF), null);
        },
        close: async () => {
          calls.closed += 1;
        },
      };
      return session;
    },
  };
  return { forge, calls };
};

/** Whether a read was answered from the cache (only a diff can be). */
const cachedOf = (result: PullRequestDiffResult): boolean | undefined =>
  result.kind === "diff" ? result.cached : undefined;

const clockAt = (start = 1_000_000) => {
  let now = start;
  return { clock: { now: () => new Date(now) }, advance: (ms: number) => (now += ms) };
};

describe("createPullRequestDiffReader", () => {
  it("pins the limits to the mirror's (ADR 0010 §4) and a short, bounded cache", () => {
    expect(PULL_REQUEST_DIFF_MAX_BYTES).toBe(1024 * 1024);
    expect(DIFF_CACHE_TTL_MS).toBe(60_000);
    expect(DIFF_CACHE_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(DIFF_CACHE_MAX_ENTRIES).toBe(64);
  });

  it("opens one session for the mirror's ids, verifies the head, reads the diff and closes", async () => {
    const { forge, calls } = fakeForge();
    const reader = createPullRequestDiffReader({ forge, ...clockAt() });
    const result = await reader.read(target());
    expect(result).toEqual({
      kind: "diff",
      headSha: HEAD,
      diff: DIFF,
      truncation: null,
      bytes: Buffer.byteLength(DIFF),
      sha256: createHash("sha256").update(DIFF).digest("hex"),
      cached: false,
    });
    expect(calls.opened).toEqual([{ installationId: 181, repositoryId: 5001 }]);
    expect(calls.pulls).toEqual([847]);
    // The mirror's revision (what the analysis read), capped like the mirror.
    expect(calls.diffs).toEqual([
      { revision: { baseSha: BASE, headSha: HEAD }, maxBytes: PULL_REQUEST_DIFF_MAX_BYTES },
    ]);
    expect(calls.closed).toBe(1);
  });

  it("takes GitHub's base when the mirror has no revision of the head yet", async () => {
    const other = "c".repeat(40);
    const { forge, calls } = fakeForge({ pull: { baseSha: other } });
    const reader = createPullRequestDiffReader({ forge, ...clockAt() });
    expect((await reader.read(target({ baseSha: null }))).kind).toBe("diff");
    expect(calls.diffs[0]?.revision).toEqual({ baseSha: other, headSha: HEAD });
  });

  it("a head that moved on GitHub: head_moved, no diff read, the session closed", async () => {
    const { forge, calls } = fakeForge({ pull: { headSha: "f".repeat(40) } });
    const reader = createPullRequestDiffReader({ forge, ...clockAt() });
    expect(await reader.read(target())).toEqual({ kind: "head_moved" });
    expect(calls.diffs).toEqual([]);
    expect(calls.closed).toBe(1);
  });

  it("not found: the installation cannot read the repository, or GitHub has no such PR", async () => {
    const gone = fakeForge({ open: "null" });
    expect(await createPullRequestDiffReader({ forge: gone.forge }).read(target())).toEqual({
      kind: "not_found",
    });
    const noPr = fakeForge({ pull: null });
    expect(await createPullRequestDiffReader({ forge: noPr.forge }).read(target())).toEqual({
      kind: "not_found",
    });
    expect(noPr.calls.diffs).toEqual([]);
    expect(noPr.calls.closed).toBe(1);
  });

  it("truncation: a cut prefix is served as whole files and flagged; GitHub's refusal and missing commits are states", async () => {
    const whole = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n";
    const partial = "diff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1,9 +1,9 @@\n-1\n+2\n";
    const cut = fakeForge({ diff: reading(Buffer.from(whole + partial), "max_bytes") });
    const served = await createPullRequestDiffReader({ forge: cut.forge }).read(target());
    expect(served).toMatchObject({
      kind: "diff",
      diff: whole,
      truncation: "max_bytes",
      bytes: Buffer.byteLength(whole),
      sha256: createHash("sha256").update(whole).digest("hex"),
    });
    // A cut inside the first file: nothing complete to show, still flagged.
    const first = fakeForge({ diff: reading(Buffer.from(partial), "max_bytes") });
    expect(await createPullRequestDiffReader({ forge: first.forge }).read(target())).toMatchObject({
      kind: "diff",
      diff: "",
      truncation: "max_bytes",
      bytes: 0,
    });
    const refused = fakeForge({ diff: reading(Buffer.alloc(0), "forge_limit") });
    expect(await createPullRequestDiffReader({ forge: refused.forge }).read(target())).toEqual({
      kind: "too_large",
    });
    const missing = fakeForge({ diff: reading(Buffer.alloc(0), "unavailable") });
    expect(await createPullRequestDiffReader({ forge: missing.forge }).read(target())).toEqual({
      kind: "commits_unavailable",
    });
  });

  it("a forge failure is a fixed code, the session is still closed, and nothing is cached", async () => {
    const failing = fakeForge({ diff: new ForgeReadError("http_status", 502) });
    const reader = createPullRequestDiffReader({ forge: failing.forge, ...clockAt() });
    expect(await reader.read(target())).toEqual({ kind: "forge_failed", code: "forge_http_502" });
    expect(failing.calls.closed).toBe(1);
    // The next read asks again (a retry after an outage must not find a cached failure).
    expect(await reader.read(target())).toEqual({ kind: "forge_failed", code: "forge_http_502" });
    expect(failing.calls.opened).toHaveLength(2);
    const minting = fakeForge({ open: new ForgeReadError("timeout") });
    expect(await createPullRequestDiffReader({ forge: minting.forge }).read(target())).toEqual({
      kind: "forge_failed",
      code: "forge_timeout",
    });
  });

  it("an unexpected error propagates (a bug, not a forge answer) after the session is closed", async () => {
    const broken = fakeForge({ pull: new Error("boom") });
    const reader = createPullRequestDiffReader({ forge: broken.forge });
    await expect(reader.read(target())).rejects.toThrow("boom");
    expect(broken.calls.closed).toBe(1);
  });

  it("decodes the bytes as UTF-8 without failing on a non-UTF-8 diff (display only)", async () => {
    const latin1 = Buffer.from("diff --git a/x b/x\n+caf\xe9\n", "latin1");
    const { forge } = fakeForge({ diff: reading(latin1, null) });
    const result = await createPullRequestDiffReader({ forge }).read(target());
    expect(result).toMatchObject({ kind: "diff", bytes: latin1.length });
    expect((result as { diff: string }).diff).toContain("caf�");
  });

  it("wholeFiles: keeps the prefix up to the last file header at a line start", () => {
    const text = (s: string) => Buffer.from(wholeFiles(Buffer.from(s))).toString();
    expect(text("diff --git a/a b/a\n+x\ndiff --git a/b b/b\n+y")).toBe("diff --git a/a b/a\n+x\n");
    // A header-looking string inside a line is content, not a boundary.
    expect(text("diff --git a/a b/a\n+x\n+ diff --git a/b b/b\n+y")).toBe("");
    expect(text("diff --git a/a b/a\n+x")).toBe("");
    expect(text("")).toBe("");
    expect(text("+x\ndiff --git a/a b/a\n+y")).toBe("+x\n");
  });

  it("refuses a malformed target before opening anything", async () => {
    const { forge, calls } = fakeForge();
    const reader = createPullRequestDiffReader({ forge });
    for (const bad of [
      { orgId: "not-a-uuid" },
      { installationId: 0 },
      { repositoryId: 1.5 },
      { number: 0 },
      { headSha: "xyz" },
      { baseSha: "short" },
    ] as Partial<PullRequestDiffTarget>[]) {
      await expect(reader.read(target(bad)), JSON.stringify(bad)).rejects.toThrow("invalid target");
    }
    expect(calls.opened).toEqual([]);
  });

  describe("cache", () => {
    it("serves a second read of the same org, repository and revision without a session, until the TTL", async () => {
      const { forge, calls } = fakeForge();
      const time = clockAt();
      const reader = createPullRequestDiffReader({ forge, clock: time.clock });
      const first = await reader.read(target());
      const second = await reader.read(target());
      expect(second).toEqual({ ...first, cached: true });
      expect(calls.opened).toHaveLength(1);
      time.advance(DIFF_CACHE_TTL_MS - 1);
      expect(cachedOf(await reader.read(target()))).toBe(true);
      time.advance(1);
      expect(cachedOf(await reader.read(target()))).toBe(false);
      expect(calls.opened).toHaveLength(2);
    });

    it("keys by org, repository, base and head: none of them shares an entry", async () => {
      const { forge, calls } = fakeForge({ heads: { 848: "d".repeat(40) } });
      const reader = createPullRequestDiffReader({ forge, ...clockAt() });
      await reader.read(target());
      for (const other of [
        { orgId: "0f1c2a9e-1d4b-4c3e-9a7f-0b2d4e6f8a1c" },
        { repositoryId: 5002 },
        { baseSha: "c".repeat(40) },
        { number: 848, headSha: "d".repeat(40) },
      ]) {
        expect(cachedOf(await reader.read(target(other))), JSON.stringify(other)).toBe(false);
      }
      expect(calls.opened).toHaveLength(5);
    });

    it("concurrent reads of one revision share one session", async () => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { forge, calls } = fakeForge({ gate: () => gate });
      const reader = createPullRequestDiffReader({ forge, ...clockAt() });
      const reads = [reader.read(target()), reader.read(target()), reader.read(target())];
      release();
      const results = await Promise.all(reads);
      expect(results.map((r) => r.kind)).toEqual(["diff", "diff", "diff"]);
      expect(calls.opened).toHaveLength(1);
    });

    it("caches diffs only: head_moved, too_large, missing commits and failures are asked again", async () => {
      for (const options of [
        { pull: { headSha: "f".repeat(40) } },
        { diff: reading(Buffer.alloc(0), "forge_limit") },
        { diff: reading(Buffer.alloc(0), "unavailable") },
        { pull: null },
        { open: "null" as const },
      ]) {
        const { forge, calls } = fakeForge(options);
        const reader = createPullRequestDiffReader({ forge, ...clockAt() });
        await reader.read(target());
        await reader.read(target());
        expect(calls.opened, JSON.stringify(options)).toHaveLength(2);
      }
    });

    it("is bounded by bytes and entries, evicting the oldest, and a diff over the byte bound is not kept", async () => {
      const big = (fill: string) =>
        reading(Buffer.from(`diff --git a/x b/x\n+${fill.repeat(100)}\n`), null);
      const { forge, calls } = fakeForge({ diff: big("x") });
      const reader = createPullRequestDiffReader({
        forge,
        ...clockAt(),
        cache: { maxBytes: 300, maxEntries: 2 },
      });
      const one = target({ baseSha: "1".repeat(40) });
      const two = target({ baseSha: "2".repeat(40) });
      const three = target({ baseSha: "3".repeat(40) });
      await reader.read(one);
      await reader.read(two);
      expect(cachedOf(await reader.read(one))).toBe(true);
      // A third entry evicts the oldest (one), whether by count or by bytes (each is 121 bytes).
      await reader.read(three);
      expect(cachedOf(await reader.read(two))).toBe(true);
      expect(cachedOf(await reader.read(one))).toBe(false);
      expect(calls.opened).toHaveLength(4);
      // Larger than the whole cache: served, never stored.
      const huge = createPullRequestDiffReader({
        forge: fakeForge({ diff: big("y".repeat(10)) }).forge,
        ...clockAt(),
        cache: { maxBytes: 300, maxEntries: 2 },
      });
      expect(cachedOf(await huge.read(one))).toBe(false);
      expect(cachedOf(await huge.read(one))).toBe(false);
    });

    it("can be turned off", async () => {
      const { forge, calls } = fakeForge();
      const reader = createPullRequestDiffReader({ forge, ...clockAt(), cache: false });
      await reader.read(target());
      await reader.read(target());
      expect(calls.opened).toHaveLength(2);
    });

    it("refuses a TTL over a minute or an unbounded cache", () => {
      const { forge } = fakeForge();
      expect(() =>
        createPullRequestDiffReader({ forge, cache: { ttlMs: DIFF_CACHE_TTL_MS + 1 } }),
      ).toThrow();
      expect(() => createPullRequestDiffReader({ forge, cache: { maxEntries: 0 } })).toThrow();
      expect(() => createPullRequestDiffReader({ forge, cache: { maxBytes: 0 } })).toThrow();
      expect(() => createPullRequestDiffReader({ forge, maxBytes: 0 })).toThrow();
    });
  });
});
