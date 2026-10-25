import { defineConfig } from "vitest/config";

/** Packages whose logic guards security, tenancy or money keep a coverage floor (PLAN.md §3). */
const COVERED = ["core", "schema", "db", "llm", "crypto"].map((p) => `packages/${p}/src/**`);

export default defineConfig({
  test: {
    include: ["{apps,packages,ee}/**/src/**/*.test.ts", "scripts/**/*.test.ts"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: COVERED,
      exclude: ["**/*.test.ts", "**/index.ts"],
      thresholds: { lines: 85, functions: 85, branches: 80, statements: 85 },
    },
  },
});
