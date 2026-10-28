import { describe, expect, it } from "vitest";
import { HeightIndex, visibleRange } from "./windowing.js";

describe("HeightIndex", () => {
  it("sums heights before an item and in total", () => {
    const index = new HeightIndex([10, 20, 30, 40]);
    expect(index.size).toBe(4);
    expect(index.total).toBe(100);
    expect([0, 1, 2, 3, 4].map((i) => index.offsetOf(i))).toEqual([0, 10, 30, 60, 100]);
    expect(index.get(2)).toBe(30);
  });

  it("finds the item that contains a y offset, clamped to the list", () => {
    const index = new HeightIndex([10, 20, 30, 40]);
    expect([-5, 0, 9, 10, 29, 30, 59, 60, 99, 100, 500].map((y) => index.indexAt(y))).toEqual([
      0, 0, 0, 1, 1, 2, 2, 3, 3, 3, 3,
    ]);
  });

  it("updates one height without rebuilding, and reports whether it changed", () => {
    const index = new HeightIndex([20, 20, 20, 20, 20]);
    expect(index.set(1, 20)).toBe(false);
    expect(index.set(1, 50)).toBe(true);
    expect(index.total).toBe(130);
    expect(index.offsetOf(2)).toBe(70);
    expect(index.indexAt(69)).toBe(1);
    expect(index.indexAt(70)).toBe(2);
  });

  it("matches a naive prefix sum after many random updates", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const heights = Array.from({ length: 997 }, () => 20);
    const index = new HeightIndex(heights);
    for (let n = 0; n < 2000; n++) {
      const i = Math.floor(rand() * heights.length);
      const h = Math.floor(rand() * 200);
      heights[i] = h;
      index.set(i, h);
    }
    let sum = 0;
    for (let i = 0; i < heights.length; i++) {
      expect(index.offsetOf(i)).toBe(sum);
      if (heights[i]! > 0) expect(index.indexAt(sum)).toBe(i);
      sum += heights[i]!;
    }
    expect(index.total).toBe(sum);
  });

  it("handles an empty list", () => {
    const index = new HeightIndex([]);
    expect(index.total).toBe(0);
    expect(index.indexAt(10)).toBe(0);
    expect(visibleRange(index, 0, 500, 100)).toEqual({ start: 0, end: 0 });
  });

  it("rejects negative or non-finite heights by treating them as zero", () => {
    const index = new HeightIndex([10, -5, Number.NaN, 10]);
    expect(index.total).toBe(20);
    index.set(0, Number.POSITIVE_INFINITY);
    expect(index.total).toBe(10);
  });
});

describe("visibleRange (virtualisation windowing)", () => {
  // 5,000 rows of 20 px: a 100,000 px list.
  const index = new HeightIndex(Array.from({ length: 5000 }, () => 20));

  it("renders only the rows in the viewport plus the overscan", () => {
    expect(visibleRange(index, 0, 800, 200)).toEqual({ start: 0, end: 50 });
    expect(visibleRange(index, 50_000, 800, 200)).toEqual({ start: 2490, end: 2550 });
  });

  it("keeps the window a small, bounded slice of a 5,000-line file", () => {
    for (const top of [0, 1234, 33_333, 99_000, 99_999]) {
      const { start, end } = visibleRange(index, top, 900, 400);
      expect(end - start).toBeLessThanOrEqual(Math.ceil((900 + 2 * 400) / 20) + 2);
      expect(start).toBeLessThanOrEqual(index.indexAt(top));
      expect(end).toBeGreaterThan(index.indexAt(Math.min(top + 899, index.total - 1)));
    }
  });

  it("clamps when the list is above or below the viewport", () => {
    expect(visibleRange(index, -5000, 800, 200)).toEqual({ start: 0, end: 0 });
    expect(visibleRange(index, -700, 800, 200)).toEqual({ start: 0, end: 15 });
    expect(visibleRange(index, 200_000, 800, 200)).toEqual({ start: 5000, end: 5000 });
    expect(visibleRange(index, 99_900, 800, 200)).toEqual({ start: 4985, end: 5000 });
  });

  it("follows measured heights", () => {
    const mixed = new HeightIndex([20, 20, 300, 20, 20, 20]);
    expect(visibleRange(mixed, 50, 100, 0)).toEqual({ start: 2, end: 3 });
    expect(visibleRange(mixed, 330, 50, 0)).toEqual({ start: 2, end: 5 });
  });
});
