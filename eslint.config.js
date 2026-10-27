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

/**
 * Instructions come from literal templates only (ADR 0012 §1): any other use of the tag (a call,
 * `.call`, `(0, tag)(x)`, an alias, a namespace member, an interpolation) could pass PR text. So
 * the name may appear only as a template tag or a same-name import/export. The runtime check in
 * core is the control; this catches it at review time.
 */
const ROCKY_MESSAGE =
  "Use rockyInstructions only as a literal tagged template (no substitutions, no alias) (ADR 0012 §1).";
const rockyInstructionsRules = (allowDefinition = false) => [
  {
    selector: `Identifier[name='rockyInstructions']:not(TaggedTemplateExpression > Identifier.tag, ImportSpecifier > Identifier, ExportSpecifier > Identifier${allowDefinition ? ", VariableDeclarator > Identifier.id" : ""})`,
    message: ROCKY_MESSAGE,
  },
  { selector: "MemberExpression[property.name='rockyInstructions']", message: ROCKY_MESSAGE },
  {
    selector: "TaggedTemplateExpression[tag.name='rockyInstructions'][quasi.expressions.length>0]",
    message: ROCKY_MESSAGE,
  },
  {
    selector: "ImportSpecifier[imported.name='rockyInstructions'][local.name!='rockyInstructions']",
    message: ROCKY_MESSAGE,
  },
  {
    selector: "ExportSpecifier[local.name='rockyInstructions'][exported.name!='rockyInstructions']",
    message: ROCKY_MESSAGE,
  },
];
const CORE_SYNTAX = [
  { selector: "ImportExpression", message: `No dynamic import in core. ${CORE_MESSAGE}` },
  {
    selector: "CallExpression[callee.name='require']",
    message: `No require in core. ${CORE_MESSAGE}`,
  },
];

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
      "no-restricted-syntax": ["error", ...rockyInstructionsRules()],
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
      "no-restricted-syntax": ["error", ...CORE_SYNTAX, ...rockyInstructionsRules()],
      "no-restricted-globals": [
        "error",
        ...["fetch", "process", "require", "XMLHttpRequest", "WebSocket", "Deno", "Bun"].map(
          (name) => ({ name, message: `No I/O globals in core. ${CORE_MESSAGE}` }),
        ),
      ],
    },
  },
  {
    // The scripted LLM fake (P4-3) ships in core's exports for tests and evals; production code
    // must never answer with it (review round 1, Fix F). Type-only imports load nothing.
    files: ["**/*.{ts,tsx,mts,cts}"],
    ignores: ["**/*.test.ts", "**/test-support.ts", "**/testing.ts", "**/testing/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@rocky-reviews/core/testing",
              message: "The scripted LLM fake is for tests only (P4-3).",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // The tag's own definition.
    files: ["packages/core/src/llm.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...CORE_SYNTAX, ...rockyInstructionsRules(true)],
    },
  },
  {
    files: ["scripts/**/*.{ts,mjs}", "packages/*/scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Tests index into fixtures under noUncheckedIndexedAccess; a `!` there is an assertion
    // about the fixture, and a wrong one fails the test loudly. Production code keeps the rule.
    // Tests also forge instructions on purpose, to check the runtime refusal.
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off", "no-restricted-syntax": "off" },
  },
  prettier,
);
