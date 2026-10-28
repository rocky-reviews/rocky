/**
 * Virtualisation windowing for large diffs (P6-3): which rows to render for a scroll position.
 * Rows have different heights (wrapped lines, flags, comments), so heights are estimated, then
 * replaced by measured ones. A Fenwick tree keeps prefix sums, so an update and a lookup are both
 * O(log n): a 5,000-line file costs about 13 steps per measured row. Pure, tested without a DOM.
 */

const clean = (h: number): number => (Number.isFinite(h) && h > 0 ? h : 0);

export class HeightIndex {
  readonly size: number;
  private readonly heights: Float64Array;
  /** 1-based Fenwick tree over `heights`. */
  private readonly tree: Float64Array;
  /** Highest power of two ≤ size, for the descent in `indexAt`. */
  private readonly top: number;

  constructor(heights: readonly number[]) {
    this.size = heights.length;
    this.heights = Float64Array.from(heights, clean);
    this.tree = new Float64Array(this.size + 1);
    // Linear build: each node adds itself to its parent.
    for (let i = 1; i <= this.size; i++) {
      this.tree[i] = (this.tree[i] ?? 0) + (this.heights[i - 1] ?? 0);
      const parent = i + (i & -i);
      if (parent <= this.size) this.tree[parent] = (this.tree[parent] ?? 0) + (this.tree[i] ?? 0);
    }
    let top = 1;
    while (top * 2 <= this.size) top *= 2;
    this.top = this.size === 0 ? 0 : top;
  }

  get total(): number {
    return this.offsetOf(this.size);
  }

  get(i: number): number {
    return this.heights[i] ?? 0;
  }

  /** Sets item `i`'s height; returns whether it changed. */
  set(i: number, height: number): boolean {
    const h = clean(height);
    const delta = h - (this.heights[i] ?? 0);
    if (i < 0 || i >= this.size || delta === 0) return false;
    this.heights[i] = h;
    for (let j = i + 1; j <= this.size; j += j & -j) this.tree[j] = (this.tree[j] ?? 0) + delta;
    return true;
  }

  /** The sum of the heights of the items before `i`, i.e. where item `i` starts. */
  offsetOf(i: number): number {
    let sum = 0;
    for (let j = Math.min(Math.max(i, 0), this.size); j > 0; j -= j & -j) sum += this.tree[j] ?? 0;
    return sum;
  }

  /** The item that contains offset `y` (clamped to the first and last item). */
  indexAt(y: number): number {
    if (this.size === 0 || y < 0) return 0;
    // Largest position whose prefix sum is ≤ y; that many items end at or before y.
    let pos = 0;
    let rest = y;
    for (let step = this.top; step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= this.size && (this.tree[next] ?? 0) <= rest) {
        pos = next;
        rest -= this.tree[next] ?? 0;
      }
    }
    return Math.min(pos, this.size - 1);
  }
}

export type Range = { readonly start: number; readonly end: number };

/**
 * Items to render when the list's visible part is `[top, top + height)` in list coordinates,
 * with `overscan` pixels more on each side. `end` is exclusive; an empty range means the list is
 * entirely outside the viewport.
 */
export const visibleRange = (
  index: HeightIndex,
  top: number,
  height: number,
  overscan: number,
): Range => {
  const from = top - overscan;
  const to = Math.min(top + height + overscan, index.total);
  if (index.size === 0 || to <= 0) return { start: 0, end: 0 };
  if (from >= index.total) return { start: index.size, end: index.size };
  return { start: index.indexAt(Math.max(from, 0)), end: index.indexAt(to - 1) + 1 };
};
