import type { Forge, LlmRoles, LlmUsage, RepositorySession } from "@rocky-reviews/core";
import { scriptedRoles, type Script } from "@rocky-reviews/core/testing";
import { PR847, pr847Diff, pr847Script } from "@rocky-reviews/evals";
import {
  createGitHubForge,
  githubEndpoints,
  parseGitHubAppAuth,
} from "@rocky-reviews/forge-github";
import { fakeGitHubApi, FIXTURE_APP_ID, testAppKeys } from "@rocky-reviews/forge-github/testing";
import { parseAnalysisDocumentJson } from "@rocky-reviews/schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TOKENS, type AnalyzeArgs } from "./args.js";
import { EXIT, runAnalyzeCommand, type AnalyzeCommandDeps } from "./analyze.js";

/**
 * P4-8 end to end, without a database or a network: `pnpm rocky analyze rocky-reviews/rocky#20`
 * against the real GitHub forge adapter on a recording fake GitHub (every request is seen), and
 * the pipeline on a scripted model (no spending). Criteria: it runs on a rocky-reviews/rocky PR,
 * its output is schema-validated, and it makes no GitHub writes.
 */

const keys = testAppKeys();
const auth = parseGitHubAppAuth({ appId: String(FIXTURE_APP_ID), privateKey: keys.privateKeyPem });
const { api } = githubEndpoints({});
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const ESC = "\u001b";
/** Untrusted PR title with terminal escapes and a bidi override. */
const TITLE = `Add invite flow ${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\ ${ESC}[2J\u202eevil`;
const CLOCK = { now: () => new Date("2026-10-27T12:00:00Z") };
/** The fake GitHub checks app JWTs against the real time. */
const REAL_CLOCK = { now: () => new Date() };

const ARGS: AnalyzeArgs = {
  command: "analyze",
  owner: "rocky-reviews",
  name: "rocky",
  fullName: "rocky-reviews/rocky",
  number: 20,
  maxTokens: DEFAULT_MAX_TOKENS,
  dryRun: false,
  json: false,
};

const github = (diff: string = pr847Diff()) => {
  const fake = fakeGitHubApi({ appId: FIXTURE_APP_ID, publicKey: keys.publicKey });
  fake.install(31, { id: 9, login: "rocky-reviews", type: "Organization" });
  fake.addRepository(31, { id: 501, fullName: "rocky-reviews/rocky" });
  fake.putPullRequest(501, { number: 20, headSha: HEAD, baseSha: BASE, title: TITLE });
  fake.putDiff(501, { baseSha: BASE, headSha: HEAD }, diff);
  return fake;
};

/** Scripted roles that also report usage, so the cap and the usage table have numbers. */
const reporting = (roles: LlmRoles, usage: LlmUsage): LlmRoles => ({
  completion: (role) => {
    const client = roles.completion(role);
    return {
      role,
      complete: async (request) => ({ ...(await client.complete(request)), usage }),
    };
  },
  embedding: () => undefined,
});

const USAGE: LlmUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadInputTokens: 0,
  cacheWrite5mInputTokens: 0,
  cacheWrite1hInputTokens: 0,
};

const run = async (
  args: Partial<AnalyzeArgs> = {},
  options: { script?: Script; forge?: Forge; fake?: ReturnType<typeof github> } = {},
) => {
  const fake = options.fake ?? github();
  const scripted = scriptedRoles(options.script ?? pr847Script);
  let built = 0;
  const out: string[] = [];
  const err: string[] = [];
  const deps: AnalyzeCommandDeps = {
    forge: options.forge ?? createGitHubForge({ auth, api, clock: REAL_CLOCK, fetch: fake.fetch }),
    llm: () => {
      built++;
      return reporting(scripted.roles, USAGE);
    },
    clock: CLOCK,
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  };
  const code = await runAnalyzeCommand(deps, { ...ARGS, ...args });
  return {
    code,
    stdout: out.join(""),
    stderr: err.join(""),
    calls: scripted.calls,
    built: () => built,
    fake,
  };
};

/** Every raw control or bidi character a terminal could act on. */
const UNSAFE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

describe("pnpm rocky analyze (P4-8)", () => {
  it("runs on a rocky-reviews/rocky PR and prints verdict, risk table and findings", async () => {
    const { code, stdout, stderr, calls } = await run();
    expect(code).toBe(EXIT.ok);
    expect(stderr).toBe("");
    expect(calls.length).toBeGreaterThan(0);

    expect(stdout).toContain("rocky-reviews/rocky#20");
    expect(stdout).toContain(`Verdict: ${PR847.briefing.verdict.level.toUpperCase()}`);
    expect(stdout).toContain(PR847.briefing.verdict.reason);
    // Risk table: each level with its files.
    for (const file of PR847.triage.files) expect(stdout).toContain(file.path);
    expect(stdout).toMatch(/critical\s/);
    expect(stdout).toContain("pnpm-lock.yaml");
    // Findings by severity, with path:line, title and body.
    const first = PR847.findings[0]!;
    expect(stdout).toContain(`${first.path}:${first.range.start}`);
    expect(stdout).toContain(first.title);
    expect(stdout).toContain(first.body.split("\n")[0]!);
    const headings = ["CRITICAL (", "HIGH (", "MEDIUM (", "LOW ("].map((h) => stdout.indexOf(h));
    expect(headings.every((at) => at > 0)).toBe(true);
    expect([...headings].sort((a, b) => a - b)).toEqual(headings);
    // Review path, provenance flags and usage per role.
    expect(stdout).toContain("Review path");
    expect(stdout).toContain(PR847.briefing.reviewPath[0]!.path);
    expect(stdout).toContain("Read by hand");
    expect(stdout).toContain("Not analysed");
    expect(stdout).toMatch(/Token usage/);
    expect(stdout).toMatch(/triage\s+\S+\s+\d+ calls?/);
  });

  it("escapes terminal control sequences from untrusted text before printing", async () => {
    const { code, stdout } = await run();
    expect(code).toBe(EXIT.ok);
    expect(stdout).not.toMatch(UNSAFE);
    expect(stdout).toContain("\\x1b]8;;https://evil.example");
    expect(stdout).toContain("\\u202eevil");
  });

  it("--json prints the raw document, valid against the schema, and usage on stderr", async () => {
    const { code, stdout, stderr } = await run({ json: true });
    expect(code).toBe(EXIT.ok);
    expect(stdout).not.toMatch(UNSAFE);
    const parsed = parseAnalysisDocumentJson(stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.provenance.repo).toEqual({ owner: "rocky-reviews", name: "rocky" });
    expect(parsed.value.provenance.pullRequest.number).toBe(20);
    expect(parsed.value.provenance.head.sha).toBe(HEAD);
    expect(stderr).toMatch(/Token usage/);
  });

  it("makes no GitHub writes: only reads, plus minting and revoking its own read-only token", async () => {
    const { code, fake } = await run();
    expect(code).toBe(EXIT.ok);
    const writes = fake.requests.filter((r) => r.method !== "GET");
    for (const request of writes) {
      expect(
        (request.method === "POST" && request.path === "/app/installations/31/access_tokens") ||
          (request.method === "DELETE" && request.path === "/installation/token"),
        `${request.method} ${request.path}`,
      ).toBe(true);
    }
    expect(fake.requests.every((r) => r.authorized)).toBe(true);
    // Every token it minted was read-only and scoped to the one repository, exactly: no other
    // permission, no other scope key. Locating the repository mints one by name (and revokes it at
    // once); the session mints one by id. Literal values, so a widened constant fails here too.
    const READ_ONLY = { contents: "read", pull_requests: "read" };
    expect(fake.tokens.mints).toEqual([
      { installationId: 31, body: { repositories: ["rocky"], permissions: READ_ONLY } },
      { installationId: 31, body: { repository_ids: [501], permissions: READ_ONLY } },
    ]);
    expect(fake.tokens.revoked).toBe(fake.tokens.mints.length);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        "GET /repos/rocky-reviews/rocky/pulls/20",
        `GET /repos/rocky-reviews/rocky/compare/${BASE}...${HEAD}`,
      ]),
    );
  });

  it("asks the forge port for reads only, and closes the session", async () => {
    const calls: string[] = [];
    const real = createGitHubForge({ auth, api, clock: REAL_CLOCK, fetch: github().fetch });
    /** Records every port call; any method beyond the reads below fails the test. */
    const forge = {
      kind: "github",
      locateRepository: (name: string) => (
        calls.push("locateRepository"),
        real.locateRepository(name)
      ),
      openRepository: async (ref: Parameters<Forge["openRepository"]>[0]) => {
        calls.push("openRepository");
        const session = await real.openRepository(ref);
        if (session === null) return null;
        const recorded: Partial<RepositorySession> = {
          repository: session.repository,
          getPullRequest: (n) => (calls.push("getPullRequest"), session.getPullRequest(n)),
          getDiff: (rev, o) => (calls.push("getDiff"), session.getDiff(rev, o)),
          close: () => (calls.push("close"), session.close()),
        };
        return recorded as RepositorySession;
      },
    } as unknown as Forge;
    const { code } = await run({}, { forge });
    expect(code).toBe(EXIT.ok);
    expect(calls).toEqual([
      "locateRepository",
      "openRepository",
      "getPullRequest",
      "getDiff",
      "close",
    ]);
  });

  it("never prints the installation tokens or the app key", async () => {
    const { stdout, stderr, fake } = await run({ json: true });
    expect(fake.tokens.issued.length).toBeGreaterThan(0);
    for (const token of fake.tokens.issued) {
      expect(stdout).not.toContain(token);
      expect(stderr).not.toContain(token);
    }
    expect(stdout + stderr).not.toContain("PRIVATE KEY");
  });

  it("--dry-run reads the PR, shows pre-triage and planned calls, and makes no model call", async () => {
    const { code, stdout, calls, built, fake } = await run({ dryRun: true });
    expect(code).toBe(EXIT.ok);
    expect(built()).toBe(0);
    expect(calls).toHaveLength(0);
    expect(fake.requests.some((r) => r.path.includes("/compare/"))).toBe(true);
    expect(stdout).toContain("Dry run");
    expect(stdout).toMatch(/pnpm-lock\.yaml\s+noise/);
    expect(stdout).toMatch(
      /db\/migrations\/20261020_add_invitations\.sql\s+triage, floored important/,
    );
    expect(stdout).toMatch(/triage\s+7 calls/);
    expect(stdout).toMatch(/Worst case/);
    expect(stdout).toContain(`cap ${DEFAULT_MAX_TOKENS.toLocaleString("en-US")}`);
    expect(stdout).not.toMatch(UNSAFE);
  });

  it("stops at the token cap before the call that would cross it, exits non-zero with usage", async () => {
    const { code, stdout, stderr, calls } = await run({ maxTokens: 40_000 });
    expect(code).toBe(EXIT.capReached);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/token cap of 40,000 reached/);
    expect(stderr).toMatch(/Token usage/);
    // Each call reports 1,200 tokens; triage reserves 16,000 output, so at most a couple ran.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(10);
    expect(stderr).not.toMatch(UNSAFE);
  });

  it("refuses a dense CJK diff before any model call (the estimate is a ceiling)", async () => {
    const lines = Array.from({ length: 300 }, () => "\u6f22".repeat(100));
    const diff = [
      "diff --git a/docs/zh.md b/docs/zh.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/zh.md",
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((line) => `+${line}`),
    ].join("\n");
    // 30,000 characters, 90,000 UTF-8 bytes: a characters / 3 estimate fitted in this cap.
    const { code, stdout, stderr, calls } = await run(
      { maxTokens: 60_000 },
      { fake: github(`${diff}\n`) },
    );
    expect(code).toBe(EXIT.capReached);
    expect(calls).toHaveLength(0);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/token cap of 60,000 reached: 0 used/);
  });

  it("reports a failed analysis with its code and usage, exit 1", async () => {
    const { code, stdout, stderr } = await run({}, { fake: github("not a diff\n") });
    expect(code).toBe(EXIT.failed);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/analysis failed: diff_/);
  });

  it("says when the app cannot see the repository or the PR", async () => {
    const missingRepo = await run({ owner: "acme", name: "api", fullName: "acme/api" });
    expect(missingRepo.code).toBe(EXIT.failed);
    expect(missingRepo.stderr).toMatch(/GitHub App is not installed on acme\/api/);

    const missingPr = await run({ number: 999 });
    expect(missingPr.code).toBe(EXIT.failed);
    expect(missingPr.stderr).toMatch(/no pull request #999 in rocky-reviews\/rocky/);
    // The session is closed on the error path too: every token minted was revoked.
    expect(missingPr.fake.tokens.mints).toHaveLength(2);
    expect(missingPr.fake.tokens.revoked).toBe(missingPr.fake.tokens.mints.length);
  });

  it("reports a forge outage by code", async () => {
    const fake = github();
    fake.failRoute("compare", 502, 5);
    const { code, stderr } = await run({}, { fake });
    expect(code).toBe(EXIT.failed);
    expect(stderr).toMatch(/forge_http_502/);
    expect(fake.tokens.mints).toHaveLength(2);
    expect(fake.tokens.revoked).toBe(fake.tokens.mints.length);
  });
});
