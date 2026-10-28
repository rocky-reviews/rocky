/**
 * Points, boxes and the one place coordinates are rounded.
 *
 * Adapted from PR Lens (https://github.com/coldteadotai/pr-lens, packages/renderer/src/
 * geometry.ts and bounds.ts at 918ffe82cb1dd71d20ce70b27917aeb80a7a4b49), MIT License,
 * Copyright (c) 2026 Coldtea AI. See NOTICE.
 */
export type Point = { x: number; y: number };

export type Box = { x: number; y: number; width: number; height: number };

/**
 * Every coordinate the renderer writes goes through here. Floating-point arithmetic that
 * differs in the last bit would otherwise change the bytes without changing the picture.
 */
export const roundCoord = (value: number): number => {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/** `String(number)` is locale-independent; `toLocaleString` and `Intl` are never used. */
export const coord = (value: number): string => String(roundCoord(value));

export const inflate = (box: Box, by: number): Box => ({
  x: box.x - by,
  y: box.y - by,
  width: box.width + by * 2,
  height: box.height + by * 2,
});

export const overlapArea = (a: Box, b: Box): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** Whether `inner` lies entirely inside `outer`. */
export const contains = (outer: Box, inner: Box): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;
