/**
 * Rules pre-triage (P4-3, ADR 0014 §3): deterministic, from the path alone, before any model.
 *
 * - Noise: lockfiles and generated files are listed as noise with a fixed, Rocky-written summary
 *   and are never sent to a model. Only these rules make a file noise; a model cannot (its triage
 *   levels stop at `low`), so PR content cannot talk a file out of review.
 * - Floors: migrations and auth paths are triaged at least `important`, so they are always
 *   reviewed whatever the triage model says. Security rules are checked first and win over the
 *   noise rules. Over-matching (`author.ts`) only adds review, never removes it.
 *
 * A PR author controls paths, so a file can be named to look generated (residual risk R1 in
 * ADR 0014): the noise summary says plainly that the AI did not read it.
 */
import { limits, type TriagedFileLevel } from "@rocky-reviews/schema";

export type NoiseRule = "lockfile" | "generated";
export type FloorRule = "migration" | "auth";
export type FloorLevel = Extract<TriagedFileLevel, "critical" | "important">;

export type PreTriage =
  | { readonly kind: "noise"; readonly rule: NoiseRule }
  | { readonly kind: "analyse"; readonly floor?: FloorLevel; readonly rule?: FloorRule };

/** What the UI shows for a noise file. Fixed text: never PR content or model output. */
export const NOISE_SUMMARIES: Readonly<Record<NoiseRule, string>> = {
  lockfile:
    "Lockfile. Rocky's rules skip lockfiles, so the AI did not read it. Check new or changed package sources by hand or with a dependency scanner.",
  generated:
    "Looks generated (by its path). Rocky's rules skip generated files, so the AI did not read it. Check it was not edited by hand.",
};

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "cargo.lock",
  "go.sum",
  "go.work.sum",
  "gemfile.lock",
  "poetry.lock",
  "pipfile.lock",
  "pdm.lock",
  "uv.lock",
  "composer.lock",
  "pubspec.lock",
  "podfile.lock",
  "package.resolved",
  "mix.lock",
  "flake.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "paket.lock",
]);

const GENERATED_SEGMENTS = new Set(["generated", "__generated__"]);
const GENERATED_NAMES =
  /(?:\.generated\.[^/]+|\.gen\.[^/]+|\.pb\.(?:go|cc|h|swift|dart)|_pb2(?:_grpc)?\.pyi?|\.g\.dart|\.freezed\.dart|\.min\.(?:js|css))$/;

const MIGRATION_SEGMENTS = new Set(["migrations", "migration", "migrate", "alembic"]);

/** Long tokens match anywhere in the path; short ones only as a whole path component word. */
const AUTH_ANYWHERE =
  /auth|login|logout|signin|signup|passw|secret|credential|crypt|session|permission|privilege|token/;
const AUTH_WORD = /(?:^|[/._-])(?:sso|saml|oidc|jwt|acls?|rbac|iam|keys?)(?:[/._-]|$)/;

const TEST_SEGMENTS = new Set(["__tests__", "test", "tests", "spec", "specs", "e2e"]);
const TEST_NAMES = /(?:\.(?:test|spec)\.[^/]+|_test\.[^/]+|_spec\.[^/]+)$/;

export const preTriage = (path: string): PreTriage => {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const name = segments.at(-1) ?? "";
  const dirs = segments.slice(0, -1);

  if (dirs.some((dir) => MIGRATION_SEGMENTS.has(dir)) || name.endsWith(".sql")) {
    return { kind: "analyse", floor: "important", rule: "migration" };
  }
  const test = dirs.some((dir) => TEST_SEGMENTS.has(dir)) || TEST_NAMES.test(name);
  if (!test && (AUTH_ANYWHERE.test(lower) || AUTH_WORD.test(lower))) {
    return { kind: "analyse", floor: "important", rule: "auth" };
  }
  if (LOCKFILES.has(name)) return { kind: "noise", rule: "lockfile" };
  if (dirs.some((dir) => GENERATED_SEGMENTS.has(dir)) || GENERATED_NAMES.test(name)) {
    return { kind: "noise", rule: "generated" };
  }
  return { kind: "analyse" };
};

const RANK: Readonly<Record<TriagedFileLevel, number>> = {
  low: 0,
  normal: 1,
  important: 2,
  critical: 3,
};

/** Raises the level (and the score into its band) to the floor; never lowers anything. */
export const applyFloor = <T extends { readonly score: number; readonly level: TriagedFileLevel }>(
  triage: T,
  floor: FloorLevel | undefined,
): T => {
  if (floor === undefined || RANK[triage.level] >= RANK[floor]) return triage;
  return {
    ...triage,
    level: floor,
    score: Math.max(triage.score, limits.SCORE_BANDS[floor].min),
  };
};
