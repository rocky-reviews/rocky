import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** P0-10: the app's tokens must stay identical to the Slate palette in the POC. */

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Formatting-insensitive: Prettier rewrites `rgba(0,0,0,.04)` as `rgba(0, 0, 0, 0.04)`. */
const normalise = (value: string): string => value.replace(/\s+/g, "").replace(/(?<!\d)0\./g, ".");

const tokens = (css: string, selector: RegExp): Map<string, string> => {
  const body = selector.exec(css)?.[1];
  if (body === undefined) throw new Error(`selector not found: ${selector.source}`);
  const pairs = [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [
    m[1],
    normalise(m[2] ?? ""),
  ]);
  return new Map(pairs as [string, string][]);
};

const LIGHT = /:root,\s*:root\[data-mode="light"\]\s*\{([\s\S]*?)\n\}/;
const DARK = /:root\[data-mode="dark"\]\s*\{([\s\S]*?)\n\}/;

const poc = read("design-poc/index.html");
const app = read("apps/web/src/styles/tokens.css");

/**
 * Tokens the app defines that the POC has no variable for. Anything else must come from the
 * POC, so the palette can't drift by adding tokens either.
 */
const DERIVED = /^--(font|text|radius|space)-|^--shadow-modal$|^--overlay$/;

describe("design tokens match the POC", () => {
  for (const [mode, selector] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    it(`${mode} mode`, () => {
      const expected = tokens(poc, selector);
      const actual = tokens(app, selector);
      expect(expected.size).toBeGreaterThan(20);
      for (const [name, value] of expected) {
        expect(actual.get(name), name).toBe(value);
      }
      const unexpected = [...actual.keys()].filter(
        (name) => !expected.has(name) && !DERIVED.test(name),
      );
      expect(unexpected, "tokens not in the POC and not listed as derived").toEqual([]);
    });
  }
});
