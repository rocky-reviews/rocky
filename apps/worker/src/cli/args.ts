import { isRepositoryFullName } from "@rocky-reviews/forge-github";

/**
 * Arguments of `pnpm rocky analyze <owner/repo>#<n>` (P4-8). Messages never echo an argument: a
 * mistyped flag can be anything someone pasted, a key included.
 */

/**
 * The default spend cap per run, in tokens (input, output, cache reads and writes, as reported).
 * Conservative: enough for a small or medium PR on the default roles, small enough that a
 * mistake costs little. Raise it with `--max-tokens` for a large PR (`--dry-run` shows the plan).
 */
export const DEFAULT_MAX_TOKENS = 500_000;
/** No run may ask for more than this. */
export const MAX_MAX_TOKENS = 50_000_000;

export const USAGE =
  "usage: pnpm rocky analyze <owner/repo>#<number> [--max-tokens N] [--dry-run] [--json]";

export class UsageError extends Error {
  override readonly name = "UsageError";
  constructor(problem: string) {
    super(`${problem}\n${USAGE}`);
  }
}

export interface AnalyzeArgs {
  readonly command: "analyze";
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly number: number;
  readonly maxTokens: number;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export type CliArgs = AnalyzeArgs | { readonly command: "help" };

const TARGET = /^([^#]+)#([1-9][0-9]{0,9})$/;

const tokens = (value: string | undefined): number => {
  if (value === undefined || !/^[1-9][0-9]{0,9}$/.test(value)) {
    throw new UsageError("--max-tokens takes a positive whole number");
  }
  const n = Number(value);
  if (n > MAX_MAX_TOKENS) {
    throw new UsageError(`--max-tokens is at most ${MAX_MAX_TOKENS.toLocaleString("en-US")}`);
  }
  return n;
};

export const parseCliArgs = (argv: readonly string[]): CliArgs => {
  const rest = argv[0] === "--" ? argv.slice(1) : [...argv];
  if (rest.length === 0 || rest.some((arg) => arg === "--help" || arg === "-h")) {
    return { command: "help" };
  }
  if (rest[0] !== "analyze") throw new UsageError("unknown command");

  let target: string | undefined;
  let maxTokens = DEFAULT_MAX_TOKENS;
  let dryRun = false;
  let json = false;
  for (let i = 1; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") json = true;
    else if (arg === "--max-tokens") maxTokens = tokens(rest[++i]);
    else if (arg.startsWith("--max-tokens=")) maxTokens = tokens(arg.slice("--max-tokens=".length));
    else if (arg.startsWith("-")) throw new UsageError("unknown option");
    else if (target === undefined) target = arg;
    else throw new UsageError("analyze takes one pull request");
  }
  if (target === undefined) throw new UsageError("which pull request?");
  const match = TARGET.exec(target);
  const fullName = match?.[1];
  if (match === null || fullName === undefined || !isRepositoryFullName(fullName)) {
    throw new UsageError("the pull request is <owner/repo>#<number>");
  }
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    command: "analyze",
    owner,
    name,
    fullName,
    number: Number(match[2]),
    maxTokens,
    dryRun,
    json,
  };
};
