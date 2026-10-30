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

/**
 * P6-8: text on a solid severity fill. Not colours of their own: each is one of the POC's
 * surface or text tokens, chosen per mode for contrast.
 */
const ON_SEVERITY = /^--on-(crit|high|med|low)$|^--crit-tint-text$/;

/**
 * P6-3 syntax colours: each `--syn-*` is a POC `--tk-*` token or one of these reviewed AA
 * shades of the same hue, so the prefix cannot bring in arbitrary colours.
 */
const SYNTAX_SHADES: Record<"light" | "dark", readonly string[]> = {
  light: ["#a3480a", "#5f6b7d"],
  dark: ["#8d99ae"],
};
const SYNTAX = /^--syn-/;

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
        (name) =>
          !expected.has(name) &&
          !DERIVED.test(name) &&
          !SYNTAX.test(name) &&
          !ON_SEVERITY.test(name),
      );
      for (const [name, value] of actual) {
        if (!ON_SEVERITY.test(name)) continue;
        expect(value, name).toMatch(/^var\(--(panel|text|crit)\)$/);
      }
      for (const [name, value] of actual) {
        if (!SYNTAX.test(name)) continue;
        const ok = /^var\(--tk-[a-z]+\)$/.test(value) || SYNTAX_SHADES[mode].includes(value);
        expect(ok, `${name}: ${value} is neither var(--tk-*) nor a listed shade`).toBe(true);
      }
      expect(unexpected, "tokens not in the POC and not listed as derived").toEqual([]);
    });
  }
});

/** WCAG 2 relative luminance of a #rrggbb colour. */
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

describe("text on a severity fill (P6-8)", () => {
  for (const [mode, selector] of [
    ["light", LIGHT],
    ["dark", DARK],
  ] as const) {
    it(`reaches 4.5:1 on every severity in ${mode} mode`, () => {
      // Dark mode overrides colours only; anything it leaves out comes from light.
      const merged = new Map([...tokens(app, LIGHT), ...tokens(app, selector)]);
      const resolve = (value: string): string => {
        const ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
        return ref === undefined ? value : resolve(merged.get(ref) ?? "");
      };
      for (const severity of ["crit", "high", "med", "low"]) {
        const fill = resolve(merged.get(`--${severity}`) ?? "");
        const text = resolve(merged.get(`--on-${severity}`) ?? "");
        expect(contrast(text, fill), `--on-${severity} on --${severity}`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      const tint = resolve(merged.get("--crit-bg") ?? "");
      const onTint = resolve(merged.get("--crit-tint-text") ?? "");
      expect(contrast(onTint, tint), "--crit-tint-text on --crit-bg").toBeGreaterThanOrEqual(4.5);
    });
  }
});
