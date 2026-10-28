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
const TESTING_MESSAGE = "Test fakes (@rocky-reviews/*/testing) are for tests only (P4-3).";
/** `import("@rocky-reviews/<pkg>/testing")` outside tests (test files turn the rule off). */
const TESTING_DYNAMIC = {
  selector: "ImportExpression[source.value=/^@rocky-reviews\\/[^/]+\\/testing$/]",
  message: TESTING_MESSAGE,
};
const CORE_SYNTAX = [
  { selector: "ImportExpression", message: `No dynamic import in core. ${CORE_MESSAGE}` },
  {
    selector: "CallExpression[callee.name='require']",
    message: `No require in core. ${CORE_MESSAGE}`,
  },
];

/**
 * HTML sinks the web app must not use (P6-1): PR content is rendered as React text only. Covers
 * dotted and computed member access, the `Object.assign(el, { innerHTML })` form, JSX props that
 * take HTML, and `document.write` on any member chain.
 */
const HTML_SINK_MESSAGE = "Render PR content as text, never as HTML (P6-1).";
const SINK_NAMES =
  "/^(innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe|parseFromString)$/";
const HTML_SINKS = [
  "JSXAttribute[name.name=/^(dangerouslySetInnerHTML|srcDoc|srcdoc)$/]",
  `MemberExpression[property.name=${SINK_NAMES}]`,
  `MemberExpression[computed=true][property.value=${SINK_NAMES}]`,
  "Property[key.name=/^(innerHTML|outerHTML)$/]",
  "Property[key.value=/^(innerHTML|outerHTML)$/]",
  "CallExpression[callee.property.name=/^(write|writeln)$/][callee.object.name='document']",
  "CallExpression[callee.property.name=/^(write|writeln)$/][callee.object.property.name='document']",
  "CallExpression[callee.property.value=/^(write|writeln)$/][callee.object.name='document']",
].map((selector) => ({ selector, message: HTML_SINK_MESSAGE }));

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "coverage/**",
      "design-poc/**",
      "artifacts/**",
      "test-results/**",
      "playwright-report/**",
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
      "no-restricted-syntax": ["error", ...rockyInstructionsRules(), TESTING_DYNAMIC],
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
        ...CORE_SYNTAX,
        ...rockyInstructionsRules(),
        TESTING_DYNAMIC,
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
    // Test fakes (`@rocky-reviews/*/testing`: the scripted LLM, recording adapters, database
    // fixtures, a fake GitHub) ship in package exports for tests and evals; production code must
    // never run on them (P4-3 review rounds 1 and 2). Only test files and test-support files may
    // import their values; type-only imports load nothing. Dynamic imports: TESTING_DYNAMIC.
    files: ["**/*.{ts,tsx,mts,cts}"],
    ignores: ["**/*.test.ts", "**/test-support.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@rocky-reviews/*/testing"],
              message: TESTING_MESSAGE,
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // The web app runs in the browser. PR content (titles, paths, branch names) is untrusted
    // and is rendered only as React text: no HTML sinks, so markup in PR content stays text
    // (P6-1). A test that needs one says why with an eslint-disable comment. Web tests keep
    // the ban too (the block after the general test override re-enables it).
    files: ["apps/web/src/**/*.{ts,tsx}", "apps/web/public/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      "no-restricted-syntax": [
        "error",
        ...rockyInstructionsRules(),
        TESTING_DYNAMIC,
        ...HTML_SINKS,
      ],
    },
  },
  {
    // The tag's own definition.
    files: ["packages/core/src/llm.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...CORE_SYNTAX,
        ...rockyInstructionsRules(true),
        TESTING_DYNAMIC,
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
    // Tests also forge instructions on purpose, to check the runtime refusal.
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off", "no-restricted-syntax": "off" },
  },
  {
    // Web tests keep the HTML-sink ban that the general test override above turns off.
    files: ["apps/web/**/*.test.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...HTML_SINKS] },
  },
  prettier,
);
