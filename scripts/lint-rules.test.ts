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
