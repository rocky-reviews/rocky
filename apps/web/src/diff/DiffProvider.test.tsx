import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DiffDataSource } from "../data/diff-data.js";
import { DEFAULT_PULL } from "../data/fixture-source.js";
import { DiffProvider, useDiff } from "./DiffProvider.js";

/**
 * H4-16: the provider hands `preload` to the page only when it was asked to (the server source);
 * otherwise it does nothing. Rendered to static markup like the other component tests, so the
 * consumer calls `preload()` while rendering (Shell calls it from an effect).
 */

const counting = () => {
  const signals: AbortSignal[] = [];
  const source: DiffDataSource = {
    load: (_pull, { signal } = {}) => {
      if (signal !== undefined) signals.push(signal);
      return new Promise(() => {});
    },
  };
  return { source, signals };
};

const Preloads = () => {
  useDiff().preload();
  return null;
};

const render = (source: DiffDataSource, preload?: boolean) =>
  renderToStaticMarkup(
    <DiffProvider
      source={source}
      pull={DEFAULT_PULL}
      {...(preload === undefined ? {} : { preload })}
    >
      <Preloads />
      <Preloads />
    </DiffProvider>,
  );

describe("DiffProvider preload", () => {
  it("starts no load without the preload switch (a fixture page), by default or when false", () => {
    for (const preload of [undefined, false]) {
      const { source, signals } = counting();
      render(source, preload);
      expect(signals, String(preload)).toHaveLength(0);
    }
  });

  it("starts exactly one load with it, however many times preload is called", () => {
    const { source, signals } = counting();
    render(source, true);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it("each provider has its own load: another source or PR starts its own", () => {
    const first = counting();
    const second = counting();
    render(first.source, true);
    render(second.source, true);
    expect(first.signals).toHaveLength(1);
    expect(second.signals).toHaveLength(1);
  });
});
