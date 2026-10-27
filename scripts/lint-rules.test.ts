/**
 * The lint rules that guard policy (P2-4: no `console` in app or package code) are tested by
 * linting planted snippets through the real ESLint config, so a config edit cannot silently
 * drop them.
 */
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: ROOT });

const ruleIds = async (filePath: string, code: string): Promise<(string | null)[]> => {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map((m) => m.ruleId);
};

describe("no-console", () => {
  it.each([
    "packages/log/src/planted.ts",
    "packages/core/src/planted.ts",
    "apps/server/src/planted.ts",
    "apps/web/src/planted.tsx",
    "ee/src/planted.ts",
  ])("fails on console.log in %s", async (file) => {
    expect(await ruleIds(file, 'console.log("x");\n')).toContain("no-console");
    expect(await ruleIds(file, 'console.error("x");\n')).toContain("no-console");
  });

  it("allows console only in scripts", async () => {
    expect(await ruleIds("scripts/planted.mjs", 'console.log("x");\n')).not.toContain("no-console");
    expect(
      await ruleIds("packages/schema/scripts/planted.ts", 'console.log("x");\n'),
    ).not.toContain("no-console");
  });
});

describe("core imports no forge SDK or adapter (P3-7)", () => {
  it.each([
    'import { Octokit } from "octokit";\n',
    'import { Octokit } from "@octokit/rest";\n',
    'import { Webhooks } from "@octokit/webhooks";\n',
    'import { verify } from "@octokit/webhooks-methods";\n',
    'export { createGitHubWebhookIngress } from "@rocky-reviews/forge-github";\n',
    'import { x } from "../../forge-github/src/index.js";\n',
    'import { createHmac } from "node:crypto";\n',
  ])("fails on %s", async (code) => {
    expect(await ruleIds("packages/core/src/planted.ts", code)).toContain("no-restricted-imports");
  });

  it("fails on a dynamic import of Octokit", async () => {
    expect(
      await ruleIds("packages/core/src/planted.ts", 'export const o = import("octokit");\n'),
    ).toContain("no-restricted-syntax");
  });

  it("allows the same imports in the GitHub adapter", async () => {
    expect(
      await ruleIds(
        "packages/forge-github/src/planted.ts",
        'import { createHmac } from "node:crypto";\nexport const h = createHmac;\n',
      ),
    ).not.toContain("no-restricted-imports");
  });
});

describe("rockyInstructions only as a literal tagged template (P4-2, ADR 0012 §1)", () => {
  const file = "packages/llm/src/planted.ts";
  const head =
    'import { rockyInstructions } from "@rocky-reviews/core";\ndeclare const pr: string;\n';

  it.each([
    ["a direct call", `${head}export const i = rockyInstructions(pr as never);\n`],
    [
      "a call through .call",
      `${head}export const i = rockyInstructions.call(undefined, pr as never);\n`,
    ],
    [
      "a sequence-expression call",
      `${head}export const i = (0, rockyInstructions)(pr as never);\n`,
    ],
    ["an interpolation", `${head}export const i = rockyInstructions\`Review \${pr}\`;\n`],
    ["passing the tag as a value", `${head}export const tag = rockyInstructions;\n`],
    [
      "an aliased import",
      'import { rockyInstructions as ri } from "@rocky-reviews/core";\nexport const i = ri`x`;\n',
    ],
    [
      "a namespace member",
      'import * as core from "@rocky-reviews/core";\nexport const i = core.rockyInstructions(["x"] as never);\n',
    ],
    [
      "a namespace member as a tag",
      'import * as core from "@rocky-reviews/core";\nexport const i = core.rockyInstructions`x`;\n',
    ],
    ["an aliased re-export", 'export { rockyInstructions as ri } from "@rocky-reviews/core";\n'],
  ])("fails on %s", async (_, code) => {
    expect(await ruleIds(file, code)).toContain("no-restricted-syntax");
  });

  it("fails in core too, outside the definition", async () => {
    expect(
      await ruleIds(
        "packages/core/src/planted.ts",
        'import { rockyInstructions } from "./llm.js";\nexport const i = rockyInstructions(["x"] as never);\n',
      ),
    ).toContain("no-restricted-syntax");
  });

  it("allows a literal tagged template and a plain re-export", async () => {
    expect(
      await ruleIds(
        file,
        `${head}export const i = rockyInstructions\`You review pull requests.\`;\n`,
      ),
    ).not.toContain("no-restricted-syntax");
    expect(
      await ruleIds(
        "packages/core/src/planted.ts",
        'export { rockyInstructions, joinInstructions } from "./llm.js";\n',
      ),
    ).not.toContain("no-restricted-syntax");
  });
});
