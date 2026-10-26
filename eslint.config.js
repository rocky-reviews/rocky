import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * packages/core is domain logic + ports only (ADR-0002). It may import nothing but these
 * and its own files; everything else (adapters, Node built-ins, other packages' sources) is
 * an error. An allowlist, so new adapter libraries are blocked without updating a list.
 */
const CORE_ALLOWED_IMPORTS = ["zod", "@rocky-reviews/schema"];
const CORE_MESSAGE =
  "packages/core holds domain logic and ports only: import zod, @rocky-reviews/schema or core's own files; inject I/O through a port (ADR-0002).";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "coverage/**",
      "design-poc/**",
      "artifacts/**",
      ".claude/worktrees/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "no-console": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["packages/core/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    // Tests may use vitest and fixtures; the purity rule is about production code.
    ignores: ["packages/core/**/*.test.*"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^(?!(?:${CORE_ALLOWED_IMPORTS.map((m) => m.replace(/[/.]/g, "\\$&")).join("|")})$)(?!\\.{1,2}/)`,
              message: CORE_MESSAGE,
            },
            { regex: "^(?:\\.\\./)+(?:[^./][^/]*/)*src(?:/|$)", message: CORE_MESSAGE },
            { regex: "^(?:\\.\\./){3,}", message: CORE_MESSAGE },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "ImportExpression", message: `No dynamic import in core. ${CORE_MESSAGE}` },
        {
          selector: "CallExpression[callee.name='require']",
          message: `No require in core. ${CORE_MESSAGE}`,
        },
      ],
      "no-restricted-globals": [
        "error",
        ...["fetch", "process", "require", "XMLHttpRequest", "WebSocket", "Deno", "Bun"].map(
          (name) => ({ name, message: `No I/O globals in core. ${CORE_MESSAGE}` }),
        ),
      ],
    },
  },
  {
    files: ["scripts/**/*.{ts,mjs}", "packages/*/scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Tests index into fixtures under noUncheckedIndexedAccess; a `!` there is an assertion
    // about the fixture, and a wrong one fails the test loudly. Production code keeps the rule.
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  prettier,
);
