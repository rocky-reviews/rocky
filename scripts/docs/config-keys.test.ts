import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RETENTION_ENV_VARS } from "@rocky-reviews/db";
import {
  AWS_REGION_VARS,
  LLM_DEFAULT_KEY_ENVS,
  LLM_ENV_VARS,
  REFUSED_AMBIENT_VARS,
} from "@rocky-reviews/llm";
import { describe, expect, it } from "vitest";
import { RATE_LIMIT_ENV_VARS } from "../../apps/server/src/security/rate-limit.js";
import {
  compareKeys,
  documentedKeys,
  dynamicFile,
  envExampleKeys,
  scanRepository,
  scanSource,
} from "./config-keys.js";

/**
 * P10-3: every configuration variable the code reads has a row in the self-host config
 * reference, and every row names a variable the code reads.
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const REFERENCE = "docs/self-host/configuration.md";
const ROOTS = [
  "apps/server/src",
  "apps/worker/src",
  "apps/web/src",
  "apps/web/vite.config.ts",
  "packages",
  "ee/src",
  "scripts",
];

/** Variables the config modules list themselves (their own source of truth). */
const SCHEMA_KEYS: readonly string[] = [
  ...LLM_ENV_VARS,
  ...LLM_DEFAULT_KEY_ENVS,
  ...AWS_REGION_VARS,
  ...REFUSED_AMBIENT_VARS,
  ...RATE_LIMIT_ENV_VARS,
  ...RETENTION_ENV_VARS,
];

/**
 * Files whose environment reads the scan cannot name, and what covers each. A new file with such
 * a read fails "every dynamic read is covered" until it is listed here with a schema list.
 */
const DYNAMIC_READS_COVERED_BY: Readonly<Record<string, string>> = {
  "apps/server/src/config.ts": "nonEmpty(): its callers pass literals, which the scan reads",
  "apps/server/src/security/rate-limit.ts": "RATE_LIMIT_ENV_VARS",
  "apps/worker/src/config.ts": "nonEmpty(), onOff(), boundedInteger(): callers pass literals",
  "packages/db/src/retention.ts": "RETENTION_ENV_VARS",
  "packages/llm/src/env.ts": "LLM_ENV_VARS, AWS_REGION_VARS",
  "packages/llm/src/registry.ts": "envSecrets(): the key variables, LLM_DEFAULT_KEY_ENVS",
  "packages/llm/src/adapters/ambient.ts": "REFUSED_AMBIENT_VARS",
  "scripts/evals.ts": "the key variables the LLM config names, LLM_DEFAULT_KEY_ENVS",
};

/** Names the scan finds that are not configuration. Each must still be found (no stale entry). */
const NOT_CONFIGURATION: Readonly<Record<string, string>> = {
  INIT_CWD: "set by pnpm for root scripts (scripts/evals.ts)",
  DEV: "import.meta.env.DEV, Vite's own build flag",
  APP_URL: "text inside a seeded eval diff (packages/evals/src/pr-847/diff.ts)",
};

const scan = scanRepository(REPO, ROOTS);
const codeKeys = new Set(
  [...scan.keys, ...SCHEMA_KEYS].filter((key) => !(key in NOT_CONFIGURATION)),
);
const reference = read(REFERENCE);
const docs = documentedKeys(reference);

describe("the self-host config reference (P10-3)", () => {
  it("documents every variable the code reads", () => {
    expect(
      compareKeys(codeKeys, docs.keys).undocumented,
      `add a row to ${REFERENCE} for each`,
    ).toEqual([]);
  });

  it("documents nothing the code does not read", () => {
    expect(
      compareKeys(codeKeys, docs.keys).unknown,
      `remove these rows from ${REFERENCE}, or read them`,
    ).toEqual([]);
  });

  it("has one row per variable", () => {
    expect(docs.duplicates).toEqual([]);
  });

  it("covers every dynamic read with a schema list", () => {
    const files = [...new Set(scan.dynamic.map(dynamicFile))].sort();
    expect(files, "list the file in DYNAMIC_READS_COVERED_BY with what covers it").toEqual(
      Object.keys(DYNAMIC_READS_COVERED_BY).sort(),
    );
  });

  it("lists only names the scan still finds as not configuration", () => {
    expect(Object.keys(NOT_CONFIGURATION).filter((key) => !scan.keys.has(key))).toEqual([]);
  });

  it("keeps .env.example to variables the code reads", () => {
    const stale = [...envExampleKeys(read(".env.example"))].filter((key) => !codeKeys.has(key));
    expect(stale, ".env.example assigns variables nothing reads").toEqual([]);
  });

  it("reads the schema lists it relies on (they are not empty)", () => {
    for (const list of [LLM_ENV_VARS, RATE_LIMIT_ENV_VARS, RETENTION_ENV_VARS]) {
      expect(list.length).toBeGreaterThan(0);
    }
    expect(LLM_ENV_VARS).toContain("ROCKY_LLM_REVIEW_MODEL");
    expect(RATE_LIMIT_ENV_VARS).toContain("ROCKY_RATE_LIMIT_ASK_ORG_DAY");
    expect(RETENTION_ENV_VARS).toContain("ORG_DELETION_GRACE_DAYS");
    expect(LLM_DEFAULT_KEY_ENVS).toContain("ANTHROPIC_API_KEY");
  });
});

describe("the check itself", () => {
  it("fails when the code reads a variable the reference does not document", () => {
    const withoutRow = reference
      .split("\n")
      .filter((line) => !line.startsWith("| `ROCKY_INDEX_AUTO`"))
      .join("\n");
    expect(compareKeys(codeKeys, documentedKeys(withoutRow).keys)).toEqual({
      undocumented: ["ROCKY_INDEX_AUTO"],
      unknown: [],
    });
    const added = scanSource("x.ts", 'const flag = env["ROCKY_NEW_FLAG"];').keys;
    expect(compareKeys(new Set([...codeKeys, ...added]), docs.keys).undocumented).toEqual([
      "ROCKY_NEW_FLAG",
    ]);
  });

  it("fails when the reference documents a variable the code does not read", () => {
    const extra = `${reference}\n| \`ROCKY_GONE\` | server | unset | Removed. |\n`;
    expect(compareKeys(codeKeys, documentedKeys(extra).keys)).toEqual({
      undocumented: [],
      unknown: ["ROCKY_GONE"],
    });
  });

  it("finds literal reads in every form the code uses", () => {
    const source = [
      'const a = env["A_ONE"];',
      "const b = process.env.B_TWO;",
      'const c = nonEmpty(env, "C_THREE");',
      'const d = boundedInteger(\n  env,\n  "D_FOUR",\n  1,\n);',
      'export const E_ENV = "E_FIVE";',
      "const e = env[E_ENV];",
      'const f = env?.["F_SIX"];',
    ].join("\n");
    const result = scanSource("x.ts", source);
    expect([...result.keys].sort()).toEqual([
      "A_ONE",
      "B_TWO",
      "C_THREE",
      "D_FOUR",
      "E_FIVE",
      "F_SIX",
    ]);
    expect(result.dynamic).toEqual([]);
  });

  it("reports reads it cannot name as dynamic", () => {
    const source = [
      "const a = env[name];",
      "const b = env[KEYS[key]];",
      "for (const k of Object.keys(env)) {}",
      "for (const [k] of Object.entries(process.env)) {}",
      "const c = valueOf(env, own);",
    ].join("\n");
    const result = scanSource("x.ts", source);
    expect(result.keys.size).toBe(0);
    expect(result.dynamic.map(dynamicFile)).toEqual(["x.ts", "x.ts", "x.ts", "x.ts", "x.ts"]);
  });

  it("counts only table rows as documented, outside code fences", () => {
    const markdown = [
      "Mentions `IN_PROSE` in a sentence.",
      "| `IN_TABLE` | server | unset | Yes. |",
      "```sh",
      "| `IN_FENCE` | no |",
      "```",
      "| `IN_TABLE` | again |",
    ].join("\n");
    expect(documentedKeys(markdown)).toEqual({
      keys: new Set(["IN_TABLE"]),
      duplicates: ["IN_TABLE"],
    });
  });

  it("reads .env.example assignments, commented out or not", () => {
    const text = "A_SET=1\n# B_COMMENTED=\n#C_TIGHT=x\n# prose with D_INLINE=no\nnot E=1\n";
    expect([...envExampleKeys(text)].sort()).toEqual(["A_SET", "B_COMMENTED", "C_TIGHT"]);
  });
});
