import { createGitHubForge } from "@rocky-reviews/forge-github";
import { createLlmRoles, envSecrets, LlmConfigError, providerAdapters } from "@rocky-reviews/llm";
import { unitKeySaltFor } from "./analysis.js";
import { parseCliArgs, USAGE, UsageError } from "./cli/args.js";
import { EXIT, runAnalyzeCommand } from "./cli/analyze.js";
import { inputAttemptsFor, loadCliConfig, missingKeys } from "./cli/config.js";
import { ConfigError } from "./config.js";

/**
 * `pnpm rocky analyze <owner/repo>#<n> [--max-tokens N] [--dry-run] [--json]` (P4-8). See
 * `docs/cli.md`. Reads `.env` when present (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`,
 * `ROCKY_LLM_*` and the key variable they name). Exit 0 done, 1 failed, 2 bad arguments or
 * configuration, 3 token cap reached.
 */

const out = (text: string) => void process.stdout.write(text);
const err = (text: string) => void process.stderr.write(text);

const HELP = `${USAGE}
Reads a pull request through the GitHub App, runs Rocky's analysis on it with your model key and
prints the briefing. Read-only: nothing is posted or stored. See docs/cli.md.
`;

const main = async (): Promise<number> => {
  let args;
  let config;
  try {
    args = parseCliArgs(process.argv.slice(2));
    if (args.command === "help") {
      out(HELP);
      return EXIT.ok;
    }
    // Also removes GITHUB_APP_PRIVATE_KEY from process.env once parsed.
    config = loadCliConfig(process.env);
  } catch (error) {
    // Messages name arguments and variables, never their values.
    const known = error instanceof UsageError || error instanceof ConfigError;
    err(`rocky: ${known ? error.message : "invalid configuration"}\n`);
    return EXIT.usage;
  }

  const secrets = envSecrets(process.env);
  if (!args.dryRun) {
    const missing = missingKeys(config.llm, secrets);
    if (missing.length > 0) {
      err(missing.map((line) => `rocky: ${line}\n`).join(""));
      return EXIT.usage;
    }
  }
  const { githubApp, llm } = config;
  const clock = { now: () => new Date() };
  try {
    return await runAnalyzeCommand(
      {
        forge: createGitHubForge({ auth: githubApp.auth, api: githubApp.api, clock }),
        // Built only for a real run; keys are read per call through `secrets`, never here.
        llm: () => createLlmRoles(llm, providerAdapters(), secrets),
        clock,
        out,
        err,
        unitKeySalt: unitKeySaltFor(llm),
        inputAttempts: inputAttemptsFor(llm),
      },
      args,
    );
  } catch (error) {
    if (error instanceof LlmConfigError) {
      err(`rocky: ${error.message}\n`);
      return EXIT.usage;
    }
    err("rocky: internal_error\n");
    return EXIT.failed;
  }
};

const code = await main();
// Let both streams drain (a pipe to `jq` or `less`) before exiting; SDK sockets must not hold
// the process open.
process.stderr.write("", () => process.stdout.write("", () => process.exit(code)));
