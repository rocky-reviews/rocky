import { describe, expect, it } from "vitest";
import type { DiffDataSource, RawDiffData } from "../data/diff-data.js";
import { createFixtureDiffSource } from "../data/diff-fixture-source.js";
import { DiffLoadError, type DiffLoadReason } from "../data/diff-http-source.js";
import { DEFAULT_PULL } from "../data/fixture-source.js";
import { createDiffLoader, type DiffLoad, preloadsDiff } from "./diff-loader.js";

/**
 * H4-16: the PR page starts loading its diff when the briefing is shown, so the first file
 * opened usually finds it ready. One load per page, shared by every file view; a preload that
 * failed for a passing reason is tried once more when a file is opened.
 */

const raw = await createFixtureDiffSource().load(DEFAULT_PULL);

/** A source whose loads the test answers one by one. */
const controlled = () => {
  const pending: { resolve: (raw: RawDiffData) => void; reject: (error: unknown) => void }[] = [];
  const signals: AbortSignal[] = [];
  const source: DiffDataSource = {
    load: (_pull, { signal } = {}) => {
      if (signal !== undefined) signals.push(signal);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  return { source, pending, signals };
};

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const track = () => {
  const seen: DiffLoad[] = [];
  return { seen, onChange: (load: DiffLoad) => seen.push(load), last: () => seen.at(-1) };
};

describe("diff loader", () => {
  it("a preload starts the load; a file opened later shares it and asks nothing more", async () => {
    const { source, pending } = controlled();
    const states = track();
    const loader = createDiffLoader(source, DEFAULT_PULL, states.onChange);

    loader.preload();
    expect(pending).toHaveLength(1);
    expect(states.last()).toEqual({ kind: "loading" });

    loader.request(); // the first file opens while the preload is in flight
    loader.preload();
    expect(pending).toHaveLength(1);

    pending[0]?.resolve(raw);
    await flush();
    expect(states.last()?.kind).toBe("ready");

    loader.request(); // later files
    loader.preload();
    expect(pending).toHaveLength(1);
  });

  it("without a preload, the first file opened starts the one load, as before", async () => {
    const { source, pending } = controlled();
    const states = track();
    const loader = createDiffLoader(source, DEFAULT_PULL, states.onChange);
    loader.request();
    loader.request();
    expect(pending).toHaveLength(1);
    pending[0]?.resolve(raw);
    await flush();
    expect(states.last()?.kind).toBe("ready");
  });

  it("a preload that failed for a passing reason shows nothing, and is tried once more on open", async () => {
    for (const reason of ["failed", "forge_failed", "rate_limited"] as const) {
      const { source, pending } = controlled();
      const states = track();
      const loader = createDiffLoader(source, DEFAULT_PULL, states.onChange);
      loader.preload();
      pending[0]?.reject(new DiffLoadError(reason));
      await flush();
      // Nothing failed as far as the page can tell: no file view says why yet.
      expect(states.last(), reason).toEqual({ kind: "idle" });

      loader.preload(); // the briefing shown again tries nothing more
      expect(pending, reason).toHaveLength(1);

      loader.request();
      expect(pending, reason).toHaveLength(2);
      expect(states.last(), reason).toEqual({ kind: "loading" });
      loader.request(); // shared
      expect(pending, reason).toHaveLength(2);

      // The retry failing too is shown, and not tried again.
      pending[1]?.reject(new DiffLoadError(reason));
      await flush();
      expect(states.last(), reason).toEqual({ kind: "failed", reason });
      loader.request();
      expect(pending, reason).toHaveLength(2);
    }
  });

  it("an unreadable answer to a preload counts as a passing failure", async () => {
    const { source, pending } = controlled();
    const states = track();
    const loader = createDiffLoader(source, DEFAULT_PULL, states.onChange);
    loader.preload();
    pending[0]?.resolve({ headSha: "Zebra", diff: 1, truncation: null });
    await flush();
    expect(states.last()).toEqual({ kind: "idle" });
    loader.request();
    pending[1]?.resolve(raw);
    await flush();
    expect(states.last()?.kind).toBe("ready");
  });

  it("a preload refused for a lasting reason is shown when a file opens, without asking again", async () => {
    const lasting: DiffLoadReason[] = [
      "signed_out",
      "not_found",
      "head_moved",
      "commits_unavailable",
      "too_large",
      "unavailable",
    ];
    for (const reason of lasting) {
      const { source, pending } = controlled();
      const states = track();
      const loader = createDiffLoader(source, DEFAULT_PULL, states.onChange);
      loader.preload();
      pending[0]?.reject(new DiffLoadError(reason));
      await flush();
      expect(states.last(), reason).toEqual({ kind: "failed", reason });
      loader.request();
      expect(pending, reason).toHaveLength(1);
    }
  });

  it("a file opened while the preload was in flight sees its failure, as today", async () => {
    const { source, pending } = controlled();
    const states = track();
    const loader = createDiffLoader(source, DEFAULT_PULL, states.onChange);
    loader.preload();
    loader.request();
    pending[0]?.reject(new DiffLoadError("forge_failed"));
    await flush();
    expect(states.last()).toEqual({ kind: "failed", reason: "forge_failed" });
    loader.request();
    expect(pending).toHaveLength(1);
  });

  it("a load the file view started is never retried", async () => {
    const { source, pending } = controlled();
    const states = track();
    const loader = createDiffLoader(source, DEFAULT_PULL, states.onChange);
    loader.request();
    pending[0]?.reject(new DiffLoadError("failed"));
    await flush();
    expect(states.last()).toEqual({ kind: "failed", reason: "failed" });
    loader.request();
    loader.preload();
    expect(pending).toHaveLength(1);
  });

  it("disposing aborts the load in flight and drops its answer", async () => {
    const { source, pending, signals } = controlled();
    const states = track();
    const loader = createDiffLoader(source, DEFAULT_PULL, states.onChange);
    loader.preload();
    loader.dispose();
    expect(signals[0]?.aborted).toBe(true);
    const before = states.seen.length;
    pending[0]?.resolve(raw);
    await flush();
    expect(states.seen).toHaveLength(before);
  });
});

describe("preloadsDiff", () => {
  const head = "a".repeat(40);
  it("preloads when the analysis is for the PR's head: its files are about to be opened", () => {
    expect(preloadsDiff(head, head)).toBe(true);
  });

  it("does not when there is no analysis (no files to open) or it is for an older push", () => {
    expect(preloadsDiff(null, head)).toBe(false);
    expect(preloadsDiff("b".repeat(40), head)).toBe(false);
  });
});
