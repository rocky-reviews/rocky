/**
 * What the change map draws (H4-5, ADR 0014 amendment): code with behaviour. The category of a
 * file comes from its path alone, deterministically, before any model, like the rules pre-triage
 * it extends. The filter narrows only the graph call's input: every file is still triaged and
 * reviewed, so a path chosen to look like a doc or a test can hide a card, never a review.
 *
 * Path rules are heuristics over ordinary names, so each rule is anchored to what makes the name
 * unambiguous (review round 1, B1 and S1–S4): a doc stem (`LICENSE`, `SECURITY`) only without an
 * extension or with a doc extension, so `security.ts` is code; a tool stem (`jest`, `semgrep`)
 * only as a config file (`jest.config.ts`, `.semgrep.yml`), so `lib/jest.ts` is code; a `*Test`
 * class suffix only behind a word boundary, so `Contest.java` is code; `scripts/`, `tools/`,
 * `ci/` and `docs/` only at the repository root or a package root (`packages/x/scripts/`), so
 * `src/agent/tools/search.ts` is code.
 *
 * Order of the rules (the first match wins):
 *
 * | #   | Category  | Rule                                                                      |
 * | --- | --------- | ------------------------------------------------------------------------- |
 * | 1   | `test`    | `__tests__/`; test infixes (rules.ts), `*.cy.*`, `*.snap`, `test_*`,      |
 * |     |           | `*Test.java`-style names behind a boundary, `conftest.py`, `tests.py`;    |
 * |     |           | `__mocks__/`, `__fixtures__/`, `__snapshots__/`, `testdata/`              |
 * | 2   | `logic`   | **kept definitions by name**: `.sql`, `.proto`, `.graphql`, `.prisma`,    |
 * |     |           | `openapi.*`, `swagger.*`, `*.schema.*`, Dockerfiles, compose, `fly.toml`, |
 * |     |           | `Procfile`, `*.tf`, `.env*` the app reads; they win over a test directory |
 * | 3   | `test`    | test directories (rules.ts: `test/`, `tests/`, `spec/`, `e2e/`, ...),     |
 * |     |           | `cypress/`, `testdata/`; `fixtures/`, `test-data/` under one of them or   |
 * |     |           | at a root                                                                 |
 * | 4   | `ci`      | `.github/`, `.gitlab/`, `.circleci/`, `.buildkite/`, `.ci/`, `ci/` at a   |
 * |     |           | root, and the well-known pipeline files                                   |
 * | 5   | `logic`   | **kept definitions by directory**: migrations, `k8s/`, `helm/`, `deploy/` |
 * | 6   | `tooling` | by name: manifests and lockfiles; build, lint, format, type-check, test   |
 * |     |           | runner and scanner configuration (`<tool>.config.*`, `.<tool>rc*`,        |
 * |     |           | `<tool>.{json,yaml,toml,...}`); editor and repository dotfiles            |
 * | 7   | `docs`    | doc extensions (`.md`, `.rst`, `.txt`, ...); `docs/`, `doc/`, `adr/`,     |
 * |     |           | `rfcs/`, `wiki/` at a root; `README`, `LICENSE`, `CHANGELOG`, ... without |
 * |     |           | an extension; `.env.example`                                              |
 * | 8   | `tooling` | by directory at a root: `scripts/`, `tools/`, `.husky/`, `.changeset/`,   |
 * |     |           | `.vscode/`, `.idea/`, `.devcontainer/`                                    |
 * | 9   | `logic`   | everything else                                                           |
 *
 * A root is the repository root or a package root: the directory right under `apps/`,
 * `packages/`, `services/`, `libs/`, `modules/`, `crates/` or `projects/`. Deploy config is kept
 * because a path cannot tell whether it changes what runs; the graph instructions tell the model
 * to map config only when code reads it. A docs site's own code under a root `docs/` is left out
 * (accepted).
 */
import { hasInfix, hasTestName, isLockfileName } from "./rules.js";

export type MapCategory = "logic" | "test" | "docs" | "tooling" | "ci";

export interface ScopedFile {
  readonly path: string;
  /** Triaged, so its diff can go to the graph call (not binary, too large, failed or refused). */
  readonly mappable: boolean;
}

/**
 * The files a graph call gets: the mappable logic files, or the mappable tests when a pull
 * request changes tests and no logic. `unmappable`: files of that category exist but none can
 * be sent, so the map is unavailable for the reason the caller knows (too large, failed), never
 * drawn from the other category. `none`: nothing of either category.
 */
export type ChangeMapScope =
  | { readonly kind: "logic" | "tests"; readonly paths: readonly string[] }
  | {
      readonly kind: "unmappable";
      readonly category: "logic" | "tests";
      readonly paths: readonly string[];
    }
  | { readonly kind: "none" };

const PACKAGE_ROOTS = new Set([
  "apps",
  "packages",
  "services",
  "libs",
  "modules",
  "crates",
  "projects",
  "workspaces",
]);

/**
 * The directory segments that sit at a root: the first one, and the one right under a package
 * root (`packages/<name>/<here>`). Only those carry the directory rules (S4).
 */
const rootDirs = (dirs: readonly string[]): readonly string[] => {
  const first = dirs[0];
  if (first === undefined) return [];
  const nested = PACKAGE_ROOTS.has(first) ? dirs[2] : undefined;
  return nested === undefined ? [first] : [first, nested];
};

// --- tests --------------------------------------------------------------------------------------
const TEST_TREE_SEGMENTS = new Set([
  "__tests__",
  "test",
  "tests",
  "spec",
  "specs",
  "e2e",
  "cypress",
]);
const TEST_DATA_SEGMENTS = new Set(["fixtures", "test-data"]);
/** Unambiguous test-data conventions (Jest, Go): a test wherever they sit. */
const JEST_SEGMENTS = new Set(["__fixtures__", "__mocks__", "__snapshots__", "testdata"]);
/**
 * `LedgerTest.java`, `ledger_test.kt`, `Ledger.Tests.cs`: the suffix behind a boundary on the
 * original-case name, so `Contest.java`, `Latest.kt` and `Attest.swift` are code (S3).
 */
const TEST_CLASS_SUFFIX =
  /(?:(?:^|[._-])[Tt]ests?|(?:^|[._-])[Ss]pecs?|[a-z0-9](?:Tests?|Specs?))\.(?:java|kt|kts|cs|php|scala|swift|groovy)$/;
const TEST_NAMES = new Set(["conftest.py", "tests.py"]);

/** A test by its name alone, or in a Jest convention directory: wins over everything. */
const isTestByName = (dirs: readonly string[], name: string, original: string): boolean =>
  dirs.includes("__tests__") ||
  dirs.some((dir) => JEST_SEGMENTS.has(dir)) ||
  hasTestName(name) ||
  name.startsWith("test_") ||
  name.endsWith(".snap") ||
  hasInfix(name, [".cy."]) ||
  TEST_CLASS_SUFFIX.test(original) ||
  TEST_NAMES.has(name);

/** A test by its directory: a test tree anywhere; test data under one, or at a root. */
const isTestByTree = (dirs: readonly string[]): boolean =>
  dirs.some((dir) => TEST_TREE_SEGMENTS.has(dir)) ||
  rootDirs(dirs).some((dir) => TEST_DATA_SEGMENTS.has(dir));

// --- CI -----------------------------------------------------------------------------------------
const CI_ROOTS = new Set([".github", ".gitlab", ".circleci", ".buildkite", ".ci", "ci"]);
const CI_NAMES = new Set([
  ".gitlab-ci.yml",
  ".travis.yml",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "jenkinsfile",
  "bitbucket-pipelines.yml",
  ".drone.yml",
  "appveyor.yml",
  ".appveyor.yml",
  "cloudbuild.yaml",
  "cloudbuild.yml",
  "codemagic.yaml",
  ".woodpecker.yml",
]);

const isCi = (dirs: readonly string[], name: string): boolean =>
  rootDirs(dirs).some((dir) => CI_ROOTS.has(dir)) || CI_NAMES.has(name);

// --- config the code reads at run time (kept) ---------------------------------------------------
const MIGRATION_SEGMENTS = new Set(["migrations", "migration", "migrate", "alembic"]);
const DEFINITION_SUFFIXES = /\.(?:sql|proto|graphql|graphqls|gql|prisma|avsc|thrift|fbs|wsdl)$/;
const DEFINITION_INFIXES = [".schema."] as const;
const DEFINITION_STEMS = /^(?:openapi|swagger)(?:[.-]|$)/;
const DEPLOY_SEGMENTS = new Set(["k8s", "kubernetes", "helm", "terraform", "deploy", "deployment"]);
const DEPLOY_NAMES = new Set(["procfile", "fly.toml", "app.yaml", "serverless.yml", "vercel.json"]);
const DEPLOY_PREFIXES = ["dockerfile", "docker-compose", "compose."] as const;
const DEPLOY_SUFFIXES = /\.(?:tf|tfvars|dockerfile)$/;
/** Samples of an env file are documentation; any other `.env*` (and `.envrc`) is read by something. */
const ENV_SAMPLES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

/** A definition by its name: wins over a test directory (`api/spec/openapi.yaml` is the API). */
const isDefinitionName = (name: string): boolean =>
  DEFINITION_SUFFIXES.test(name) ||
  hasInfix(name, DEFINITION_INFIXES) ||
  DEFINITION_STEMS.test(name) ||
  DEPLOY_NAMES.has(name) ||
  DEPLOY_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
  DEPLOY_SUFFIXES.test(name) ||
  (name.startsWith(".env") && !ENV_SAMPLES.has(name));

/** A definition by its directory: a migration or deploy tree, for a file that is not a doc. */
const isDefinitionTree = (dirs: readonly string[], name: string): boolean =>
  !isDocName(name) && dirs.some((dir) => MIGRATION_SEGMENTS.has(dir) || DEPLOY_SEGMENTS.has(dir));

// --- docs ---------------------------------------------------------------------------------------
const DOC_SEGMENTS = new Set([
  "docs",
  "doc",
  "documentation",
  "adr",
  "adrs",
  "rfc",
  "rfcs",
  "wiki",
]);
const DOC_SUFFIXES = /\.(?:md|mdx|markdown|rst|txt|adoc|asciidoc|org|pod|cff)$/;
/** Only without an extension (`LICENSE`, `LICENSE-MIT`, `README`) or with a doc one (`SECURITY.md`). */
const DOC_STEMS =
  /^(?:readme|license|licence|copying|notice|authors|contributors|changelog|changes|history|codeowners|contributing|security|funding|code_of_conduct|citation)(?:[-_][a-z0-9._-]*)?$/;
const DOC_NAMES = new Set([".mailmap"]);

const isDocName = (name: string): boolean =>
  DOC_SUFFIXES.test(name) ||
  (!name.includes(".") && DOC_STEMS.test(name)) ||
  DOC_NAMES.has(name) ||
  ENV_SAMPLES.has(name);

const isDoc = (dirs: readonly string[], name: string): boolean =>
  rootDirs(dirs).some((dir) => DOC_SEGMENTS.has(dir)) || isDocName(name);

// --- tooling ------------------------------------------------------------------------------------
const TOOLING_SEGMENTS = new Set([
  "scripts",
  "tools",
  ".husky",
  ".changeset",
  ".vscode",
  ".idea",
  ".devcontainer",
  ".yarn",
]);
const TOOLING_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".python-version",
  ".ruby-version",
  ".editorconfig",
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".dockerignore",
  ".prettierignore",
  ".eslintignore",
  ".snyk",
  ".yamllint",
  "jsconfig.json",
  "nest-cli.json",
  "sonar-project.properties",
  ".pre-commit-config.yaml",
  "pyproject.toml",
  "setup.cfg",
  "setup.py",
  "tox.ini",
  "pytest.ini",
  ".flake8",
  "mypy.ini",
  "ruff.toml",
  ".ruff.toml",
  "pipfile",
  "cargo.toml",
  "go.mod",
  "gemfile",
  ".rubocop.yml",
  ".golangci.yml",
  ".golangci.yaml",
  "makefile",
  "gnumakefile",
  "justfile",
  "taskfile.yml",
  "taskfile.yaml",
  "cmakelists.txt",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "directory.build.props",
  ".swiftlint.yml",
  ".clang-format",
  ".clang-tidy",
  "browserslist",
  ".browserslistrc",
  "gulpfile.js",
  "gulpfile.ts",
  "gulpfile.mjs",
  "gruntfile.js",
  "karma.conf.js",
  "karma.conf.ts",
]);
/**
 * A build, lint, format, type-check, test-runner or scanner tool, matched only as its
 * configuration file (S1): `<tool>rc`, `<tool>rc.json`, `<tool>ignore`, `<tool>.config.*`,
 * `<tool>.workspace.*`, `<tool>.setup.*`, or `<tool>.<config extension>`. A leading dot is
 * stripped first (`.eslintrc.json`, `.semgrep.yml`). `semgrep.ts` or `lib/jest.ts` is code. `vite`
 * also covers `vitest`; `next`, `nuxt` and `app` are not here, their config is read at run time.
 */
const TOOL_CONFIG =
  /^(?:eslint|prettier|vitest|vite|jest|babel|rollup|webpack|esbuild|tsup|tsdown|unbuild|rspack|rsbuild|parcel|swc|commitlint|lint-staged|lintstaged|stylelint|knip|biome|oxlint|playwright|cypress|mocha|karma|ava|nyc|c8|tailwind|postcss|turbo|nx|lerna|renovate|codecov|sonar|wallaby|typedoc|jsdoc|dprint|rome|gitleaks|semgrep|trivy|snyk|checkov|tflint|hadolint|shellcheck|actionlint|markdownlint|yamllint|cspell|osv-scanner|zap)(?:rc(?:\.[a-z0-9]+)?|ignore|\.(?:config|conf|workspace|setup)\.[a-z0-9.]+|\.(?:json|jsonc|json5|yaml|yml|toml|ini|cjs|mjs))$/;
const TSCONFIG = /^tsconfig[\w.-]*\.json$/;
const REQUIREMENTS = /^requirements[\w.-]*\.(?:txt|in)$/;
const TOOLING_SUFFIXES = /\.(?:csproj|fsproj|vbproj|sln|lock|lockb)$/;

const isToolingName = (name: string): boolean =>
  TOOLING_NAMES.has(name) ||
  isLockfileName(name) ||
  TOOL_CONFIG.test(name.startsWith(".") ? name.slice(1) : name) ||
  TSCONFIG.test(name) ||
  REQUIREMENTS.test(name) ||
  TOOLING_SUFFIXES.test(name);

const isToolingTree = (dirs: readonly string[]): boolean =>
  rootDirs(dirs).some((dir) => TOOLING_SEGMENTS.has(dir));

// ------------------------------------------------------------------------------------------------

export const mapCategory = (path: string): MapCategory => {
  const segments = path.split("/");
  const original = segments.at(-1) ?? "";
  const lower = path.toLowerCase().split("/");
  const name = lower.at(-1) ?? "";
  const dirs = lower.slice(0, -1);
  if (isTestByName(dirs, name, original)) return "test";
  if (isDefinitionName(name)) return "logic";
  if (isTestByTree(dirs)) return "test";
  if (isCi(dirs, name)) return "ci";
  if (isDefinitionTree(dirs, name)) return "logic";
  if (isToolingName(name)) return "tooling";
  if (isDoc(dirs, name)) return "docs";
  if (isToolingTree(dirs)) return "tooling";
  return "logic";
};

/**
 * What the graph call may see, in the caller's order (S5: decided over every file the rules left
 * to the AI, not only the ones triage answered for). The logic files decide: when the pull
 * request changes logic, the map is the mappable logic files, or unavailable when none is
 * mappable (never the tests). Without logic, the tests are the logic, with the same rule. With
 * neither, there is nothing to map (`provenance.graphUnavailable.reason: no-logic`).
 */
export const changeMapScope = (files: readonly ScopedFile[]): ChangeMapScope => {
  const categorised = files.map((file) => ({ ...file, category: mapCategory(file.path) }));
  for (const [kind, category] of [
    ["logic", "logic"],
    ["tests", "test"],
  ] as const) {
    const all = categorised.filter((file) => file.category === category);
    if (all.length === 0) continue;
    const mappable = all.filter((file) => file.mappable).map((file) => file.path);
    if (mappable.length > 0) return { kind, paths: mappable };
    return { kind: "unmappable", category: kind, paths: all.map((file) => file.path) };
  }
  return { kind: "none" };
};
