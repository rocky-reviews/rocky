/**
 * What the change map draws (H4-5, ADR 0014 amendment): code with behaviour. The category of a
 * file comes from its path alone, deterministically, before any model, like the rules pre-triage
 * it extends. The filter narrows only the graph call's input: every file is still triaged and
 * reviewed, so a path chosen to look like a doc or a test can hide a card, never a review.
 *
 * Order of the rules (the first match wins):
 *
 * | #   | Category  | Rule                                                                      |
 * | --- | --------- | ------------------------------------------------------------------------- |
 * | 1   | `test`    | test directories and infixes (rules.ts), fixtures, mocks, snapshots, e2e  |
 * |     |           | and Cypress trees, `test_*`, `*Test.java`-style names, `conftest.py`      |
 * | 2   | `ci`      | anything under `.github/`, `.gitlab/`, `.circleci/`, `.buildkite/`, `ci/` |
 * |     |           | or `.ci/`, a `ci/` segment anywhere, and the well-known pipeline files    |
 * | 3   | `logic`   | **kept config**: migrations and `.sql`; API and schema definitions        |
 * |     |           | (`.proto`, `.graphql`, `.prisma`, `openapi.*`, `swagger.*`,               |
 * |     |           | `*.schema.json`, `*.avsc`); deploy config (Dockerfiles, compose,          |
 * |     |           | `fly.toml`, `Procfile`, `k8s`/`helm`/Terraform); `.env*` the app reads    |
 * | 4   | `tooling` | by name: package manifests and lockfiles; build, lint, format, type-check |
 * |     |           | and test-runner config (ESLint, Prettier, tsconfig, Vitest, Jest, Vite,   |
 * |     |           | ...); editor and repo dotfiles                                            |
 * | 5   | `docs`    | Markdown, reStructuredText, AsciiDoc, `.txt`; `docs/`, `doc/`, `adr/`,    |
 * |     |           | `rfcs/`, `wiki/`; licences, notices, changelogs, owners, `.env.example`   |
 * | 6   | `tooling` | by directory: `scripts/`, `tools/`, `.husky/`, `.changeset/`, `.vscode/`  |
 * | 7   | `logic`   | everything else                                                           |
 *
 * Deploy config is kept because a path cannot tell whether it changes what runs; the graph
 * instructions tell the model to map config only when code reads it. Test tooling config is
 * tooling, a test tree is a test. A docs site's own code under `docs/` is left out (accepted).
 */
import { hasInfix, isTestPath } from "./rules.js";

export type MapCategory = "logic" | "test" | "docs" | "tooling" | "ci";

/** The files a graph call gets: the logic set, or the tests when that is all the PR changes. */
export type ChangeMapScope =
  | { readonly kind: "logic" | "tests"; readonly paths: readonly string[] }
  | { readonly kind: "none" };

// --- 1. tests ---------------------------------------------------------------------------------
const TEST_TREE_SEGMENTS = new Set([
  "fixtures",
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
  "testdata",
  "test-data",
  "cypress",
]);
const TEST_NAME_SUFFIX = /(?:tests?|specs?)\.(?:java|kt|kts|cs|php|scala|swift|groovy)$/;
const TEST_NAMES = new Set(["conftest.py"]);

const isTest = (dirs: readonly string[], name: string): boolean =>
  dirs.some((dir) => TEST_TREE_SEGMENTS.has(dir)) ||
  name.startsWith("test_") ||
  name.endsWith(".snap") ||
  hasInfix(name, [".cy."]) ||
  TEST_NAME_SUFFIX.test(name) ||
  TEST_NAMES.has(name);

// --- 2. CI --------------------------------------------------------------------------------------
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
  (dirs.length > 0 && CI_ROOTS.has(dirs[0] as string)) || dirs.includes("ci") || CI_NAMES.has(name);

// --- 3. config the code reads at run time (kept) ----------------------------------------------
const MIGRATION_SEGMENTS = new Set(["migrations", "migration", "migrate", "alembic"]);
const DEFINITION_SUFFIXES = /\.(?:sql|proto|graphql|graphqls|gql|prisma|avsc|thrift|fbs|wsdl)$/;
const DEFINITION_INFIXES = [".schema."] as const;
const DEFINITION_STEMS = /^(?:openapi|swagger)(?:[.-]|$)/;
const DEPLOY_SEGMENTS = new Set(["k8s", "kubernetes", "helm", "terraform", "deploy", "deployment"]);
const DEPLOY_NAMES = new Set(["procfile", "fly.toml", "app.yaml", "serverless.yml", "vercel.json"]);
const DEPLOY_PREFIXES = ["dockerfile", "docker-compose", "compose."] as const;
const DEPLOY_SUFFIXES = /\.(?:tf|tfvars|dockerfile)$/;
/** Samples of an env file are documentation; any other `.env*` is read by something. */
const ENV_SAMPLES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

const isRuntimeDefinition = (dirs: readonly string[], name: string): boolean =>
  dirs.some((dir) => MIGRATION_SEGMENTS.has(dir)) ||
  DEFINITION_SUFFIXES.test(name) ||
  hasInfix(name, DEFINITION_INFIXES) ||
  DEFINITION_STEMS.test(name) ||
  DEPLOY_NAMES.has(name) ||
  DEPLOY_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
  DEPLOY_SUFFIXES.test(name) ||
  (name.startsWith(".env") && !ENV_SAMPLES.has(name)) ||
  (dirs.some((dir) => DEPLOY_SEGMENTS.has(dir)) && !isDocName(name));

// --- 4. docs ------------------------------------------------------------------------------------
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
const DOC_STEMS = new Set([
  "readme",
  "license",
  "licence",
  "copying",
  "notice",
  "authors",
  "contributors",
  "changelog",
  "changes",
  "history",
  "codeowners",
  "contributing",
  "security",
  "funding",
  "code_of_conduct",
  "citation",
]);
const DOC_NAMES = new Set([".mailmap"]);

/** `README`, `LICENSE.txt`, `CHANGELOG.md`: the stem before the first dot. */
const stemOf = (name: string): string => {
  const dot = name.indexOf(".", 1);
  return dot === -1 ? name : name.slice(0, dot);
};

const isDocName = (name: string): boolean =>
  DOC_SUFFIXES.test(name) ||
  DOC_STEMS.has(stemOf(name)) ||
  DOC_NAMES.has(name) ||
  ENV_SAMPLES.has(name);

const isDoc = (dirs: readonly string[], name: string): boolean =>
  dirs.some((dir) => DOC_SEGMENTS.has(dir)) || isDocName(name);

// --- 5. tooling -------------------------------------------------------------------------------
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
  "jsconfig.json",
  "turbo.json",
  "nx.json",
  "lerna.json",
  "knip.json",
  "biome.json",
  "biome.jsonc",
  "renovate.json",
  "renovate.json5",
  "codecov.yml",
  ".codecov.yml",
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
]);
/**
 * A build, lint, format, type-check or test-runner tool, matched as the start of the file name
 * (a leading dot stripped): `eslint.config.js`, `.eslintrc.json`, `tsconfig.base.json`,
 * `vitest.workspace.ts`, and the scanners' configuration (`.gitleaks.toml`, `.semgrep.yml`,
 * `.trivyignore`). `vite` also covers `vitest`; `next`, `nuxt` and `app` are not here, their
 * config is read at run time.
 */
const TOOL_STEMS =
  /^(?:eslint|prettier|tsconfig|vitest|vite|jest|babel|rollup|webpack|esbuild|tsup|tsdown|unbuild|rspack|rsbuild|parcel|swc|commitlint|lint-staged|lintstaged|stylelint|knip|biome|oxlint|playwright|cypress|mocha|karma|ava|nyc|c8|tailwind|postcss|turbo|nx|lerna|renovate|codecov|sonar|gulpfile|gruntfile|wallaby|typedoc|jsdoc|dprint|rome|gitleaks|semgrep|semgrepignore|trivy|trivyignore|snyk|checkov|tflint|hadolint|shellcheck|actionlint|markdownlint|yamllint|cspell|osv-scanner|zap)(?:rc|ignore|\.|$)/;
const TOOLING_SUFFIXES = /\.(?:csproj|fsproj|vbproj|sln|lock|lockb)$/;
const TOOLING_PREFIXES = ["requirements", "tsconfig"] as const;

const isToolingName = (name: string): boolean =>
  TOOLING_NAMES.has(name) ||
  TOOL_STEMS.test(name.startsWith(".") ? name.slice(1) : name) ||
  TOOLING_SUFFIXES.test(name) ||
  TOOLING_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
  name === "pnpm-lock.yaml" ||
  name === "package-lock.json";

const isToolingTree = (dirs: readonly string[]): boolean =>
  dirs.some((dir) => TOOLING_SEGMENTS.has(dir));

// ------------------------------------------------------------------------------------------------

export const mapCategory = (path: string): MapCategory => {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const name = segments.at(-1) ?? "";
  const dirs = segments.slice(0, -1);
  if (isTestPath(lower) || isTest(dirs, name)) return "test";
  if (isCi(dirs, name)) return "ci";
  if (isRuntimeDefinition(dirs, name)) return "logic";
  if (isToolingName(name)) return "tooling";
  if (isDoc(dirs, name)) return "docs";
  if (isToolingTree(dirs)) return "tooling";
  return "logic";
};

/**
 * The files a graph call may see, in the caller's order: the logic files, or, when a pull
 * request changes tests and no logic, the tests ("the tests are the logic"). A docs-, tooling-
 * or CI-only pull request has nothing to map (`provenance.graphUnavailable.reason: no-logic`).
 */
export const changeMapScope = (paths: readonly string[]): ChangeMapScope => {
  const categories = paths.map((path) => [path, mapCategory(path)] as const);
  const logic = categories.filter(([, category]) => category === "logic").map(([path]) => path);
  if (logic.length > 0) return { kind: "logic", paths: logic };
  const tests = categories.filter(([, category]) => category === "test").map(([path]) => path);
  if (tests.length > 0) return { kind: "tests", paths: tests };
  return { kind: "none" };
};
