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
 * Every environment read the scan cannot name, by its exact `file: expression` label, and what
 * covers it. A new such read (in any file, listed or not) fails "covers every dynamic read"
 * until it is reviewed and listed here; a listed label the scan no longer finds fails too.
 */
const DYNAMIC_READS_COVERED_BY: Readonly<Record<string, string>> = {
  "apps/server/src/config.ts: env[name]":
    "nonEmpty(): its callers pass literals, which the scan reads",
  "apps/server/src/main.ts: (process.env, log)": "startServer(env, log): passes the environment on",
  "apps/server/src/security/rate-limit.ts: Object.entries(env)": "RATE_LIMIT_ENV_VARS",
  "apps/worker/src/config.ts: (env, llm)":
    "indexConfigFromEnv(env, llm): passes the environment on",
  "apps/worker/src/config.ts: (env, name)": "onOff(), boundedInteger(): callers pass literals",
  "apps/worker/src/config.ts: env[name]": "nonEmpty(): its callers pass literals",
  "packages/db/src/retention.ts: env[ENV_KEYS[key]": "RETENTION_ENV_VARS",
  "packages/llm/src/adapters/ambient.ts: env[name]": "REFUSED_AMBIENT_VARS",
  "packages/llm/src/env.ts: (env, aws)": "AWS_REGION_VARS",
  "packages/llm/src/env.ts: (env, kind)": "providerBlock(): LLM_ENV_VARS",
  "packages/llm/src/env.ts: (env, name)": "valueOf(): LLM_ENV_VARS",
  "packages/llm/src/env.ts: (env, own)": "labelFor(): LLM_ENV_VARS",
  "packages/llm/src/env.ts: (env, role,": "completionRole(): LLM_ENV_VARS",
  "packages/llm/src/env.ts: Object.keys(env)": "the unknown-variable check over ROCKY_LLM_*",
  "packages/llm/src/env.ts: env[name]": "valueOf(): LLM_ENV_VARS, AWS_REGION_VARS",
  "packages/llm/src/registry.ts: env[name]":
    "envSecrets(): the key variables, LLM_DEFAULT_KEY_ENVS",
  "scripts/evals.ts: env[embedKey]": "the embedding key the LLM config names, LLM_DEFAULT_KEY_ENVS",
  "scripts/evals.ts: env[name]": "the key variables the LLM config names, LLM_DEFAULT_KEY_ENVS",
};

/**
 * Names the scan finds that are not configuration, per file. Each must still be found in that
 * file (no stale entry), and the same name read anywhere else counts as configuration.
 */
const NOT_CONFIGURATION: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "scripts/evals.ts": { INIT_CWD: "set by pnpm for root scripts" },
  "apps/web/src/main.tsx": { DEV: "import.meta.env.DEV, Vite's own build flag" },
  "packages/evals/src/pr-847/diff.ts": { APP_URL: "text inside a seeded eval diff" },
};

const scan = scanRepository(REPO, ROOTS);
const scannedKeys = [...scan.keysByFile].flatMap(([file, keys]) =>
  [...keys].filter((key) => !(key in (NOT_CONFIGURATION[file] ?? {}))),
);
const codeKeys = new Set([...scannedKeys, ...SCHEMA_KEYS]);
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

  it("covers every dynamic read, by its exact label", () => {
    expect(scan.dynamic, "review the read and list its label in DYNAMIC_READS_COVERED_BY").toEqual(
      Object.keys(DYNAMIC_READS_COVERED_BY).sort(),
    );
  });

  it("lists only names the scan still finds as not configuration, in their file", () => {
    const stale = Object.entries(NOT_CONFIGURATION).flatMap(([file, names]) =>
      Object.keys(names)
        .filter((key) => scan.keysByFile.get(file)?.has(key) !== true)
        .map((key) => `${file}: ${key}`),
    );
    expect(stale).toEqual([]);
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

  it.each([
    ["an index", 'const a = env["KEY_X"];'],
    ["a property", "const b = process.env.KEY_X;"],
    ["an optional property", "const c = env?.KEY_X;"],
    ["an optional index", 'const d = env?.["KEY_X"];'],
    ["a helper with env first", 'const e = nonEmpty(env, "KEY_X");'],
    ["a helper over several lines", 'const f = boundedInteger(\n  env,\n  "KEY_X",\n  1,\n);'],
    ["a helper on this.env", 'const g = nonEmpty(this.env, "KEY_X");'],
    ["a helper on deps.env", 'const h = nonEmpty(deps.env, "KEY_X");'],
    ["a helper with the name first", 'const i = read("KEY_X", env);'],
    ["an index on a member env", 'const j = deps.env["KEY_X"];'],
    ["a membership test", 'if ("KEY_X" in env) {}'],
    ["destructuring env", "const { KEY_X } = env;"],
    ["destructuring process.env", "const { OTHER: o, KEY_X = 'd' } = process.env;"],
    ["a same-file constant", 'export const X_ENV = "KEY_X";\nconst k = env[X_ENV];'],
  ])("finds a literal read: %s", (_form, source) => {
    const result = scanSource("x.ts", source);
    expect(result.keys.has("KEY_X")).toBe(true);
    expect(result.dynamic).toEqual([]);
  });

  it.each([
    ["an index by a variable", "const a = env[name];", "x.ts: env[name]"],
    ["a computed index", "const b = env[KEYS[key]];", "x.ts: env[KEYS[key]"],
    ["Object.keys", "for (const k of Object.keys(env)) {}", "x.ts: Object.keys(env)"],
    [
      "Object.entries of process.env",
      "for (const [k] of Object.entries(process.env)) {}",
      "x.ts: Object.entries(process.env)",
    ],
    ["Object.values", "const v = Object.values(env);", "x.ts: Object.values(env)"],
    ["a helper by identifier", "const c = valueOf(env, own);", "x.ts: (env, own)"],
    ["an alias", "const e = process.env;\nconst x = e.KEY_Y;", "x.ts: const e = process.env"],
    ["a for-in walk", "for (const k in env) {}", "x.ts: for (const k in env"],
    ["a rest element", "const { A_ONE, ...rest } = env;", "x.ts: { A_ONE, ...rest } = env"],
  ])("reports a read it cannot name: %s", (_form, source, expected) => {
    expect(scanSource("x.ts", source).dynamic).toEqual([expected]);
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
