import { defineConfig } from "vitest/config";

/** Packages whose logic guards security, tenancy or money keep a coverage floor. */
const COVERED = ["core", "schema", "db", "llm", "crypto", "renderer"].map(
  (p) => `packages/${p}/src/**`,
);

export default defineConfig({
  test: {
    include: ["{apps,packages,ee}/**/src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: COVERED,
      // Test helpers are not product code: the renderer's corpus, inspector, reference
      // normaliser and fixtures would otherwise lift its own floor.
      exclude: [
        "**/*.test.{ts,tsx}",
        ...["inspect", "hostile-corpus", "reference-normalise", "testing", "test-support"].map(
          (file) => `packages/renderer/src/${file}.ts`,
        ),
      ],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
