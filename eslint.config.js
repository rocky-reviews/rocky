import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Adapters and I/O libraries that the domain core must never import (hexagonal rule, ADR-0002). */
const ADAPTER_LIBS = [
  "pg",
  "pg-boss",
  "drizzle-orm",
  "drizzle-orm/*",
  "fastify",
  "@octokit/*",
  "octokit",
  "@anthropic-ai/*",
  "@aws-sdk/*",
  "@paddle/*",
  "@rocky-reviews/db",
  "@rocky-reviews/forge-github",
  "@rocky-reviews/llm",
];

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "coverage/**", "design-poc/**", "artifacts/**"] },
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
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ADAPTER_LIBS,
              message:
                "packages/core holds domain logic and ports only; import adapters from outside core (ADR-0002).",
            },
            { group: ["node:*"], message: "packages/core does no I/O; inject it through a port." },
          ],
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.{ts,mjs}"],
    rules: { "no-console": "off" },
  },
  prettier,
);
