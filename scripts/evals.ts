import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evalsCli, type LiveTarget } from "@rocky-reviews/evals";
import {
  createLlmRoles,
  envSecrets,
  LlmConfigError,
  llmConfigFromEnv,
  providerAdapters,
} from "@rocky-reviews/llm";

/**
 * The eval suite (P4-7, packages/evals/README.md):
 *
 *   pnpm evals run --fake                      scripted roles: tests the harness, free
 *   pnpm evals run --dry-run                   checks the config and key, calls nothing
 *   pnpm evals run [--injection] [--max-tokens N] [--only pr-847,…] [--out path]
 *   pnpm evals compare <baseline.json> <report.json>
 *
 * A live run builds the roles exactly as the worker does, from `ROCKY_LLM_*` and the key the
 * config names (BYOK, e.g. ANTHROPIC_API_KEY), read from this process's environment only.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROLES = ["triage", "review", "graph"] as const;
/** pnpm runs root scripts at the root; relative paths are the caller's. */
const CWD = process.env["INIT_CWD"] ?? process.cwd();

const live = (env: Readonly<Record<string, string | undefined>>): LiveTarget => {
  try {
    const config = llmConfigFromEnv(env);
    const roles = createLlmRoles(config, providerAdapters(), envSecrets(env));
    const used = new Set(ROLES.map((role) => config.roles[role].provider));
    const missingSecrets = [...used].flatMap((kind) => {
      const settings = config.providers[kind] as { apiKeyEnv?: string } | undefined;
      const name = settings?.apiKeyEnv;
      return name !== undefined && (env[name] ?? "") === "" ? [name] : [];
    });
    return {
      roles,
      missingSecrets: [...new Set(missingSecrets)],
      models: Object.fromEntries(
        ROLES.map((role) => {
          const target = config.roles[role];
          return [
            role,
            { provider: target.provider, model: target.model, effort: target.effort ?? null },
          ];
        }),
      ),
    };
  } catch (error) {
    // LlmConfigError names variables and fixed messages only; anything else is not printed.
    throw error instanceof LlmConfigError ? error : new Error("could not build the LLM roles");
  }
};

const code = await evalsCli(
  process.argv.slice(2),
  {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readFile: (path) => readFile(resolve(CWD, path), "utf8"),
    writeFile: async (path, text) => {
      const target = resolve(CWD, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, text);
    },
    env: process.env,
    clock: { now: () => new Date() },
    defaultOut: (kind, stamp) => resolve(ROOT, "packages/evals/reports", `${kind}-${stamp}.json`),
  },
  { live },
);
process.exit(code);
