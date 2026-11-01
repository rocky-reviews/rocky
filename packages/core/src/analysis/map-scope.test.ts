import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { changeMapScope, mapCategory, type MapCategory } from "./map-scope.js";

/**
 * H4-5: the change map shows code with behaviour. The category comes from the path alone,
 * deterministically, before any model; the rule table is in ADR 0014 (amendment H4-5).
 */

const cases: Record<MapCategory, string[]> = {
  logic: [
    "src/billing/ledger.ts",
    "packages/core/src/ports.ts",
    "apps/web/src/App.tsx",
    "lib/ledger.rb",
    "cmd/server/main.go",
    "app/models/user.py",
    "src/author.ts",
    "bin/rocky",
    "design-poc/index.html",
    "src/styles/tokens.css",
    "next.config.js",
    "app.config.ts",
    "src/config.ts",
    "config/feature-flags.yml",
    "config/settings.yaml",
    "src/flags/features.json",
    "Dockerfile",
    "apps/server/Dockerfile.prod",
    "docker-compose.yml",
    "fly.toml",
    "deploy/k8s/deployment.yaml",
    "infra/main.tf",
    "Procfile",
    "openapi.yaml",
    "api/openapi.json",
    "docs/openapi.yaml",
    "proto/ledger.proto",
    "schema.graphql",
    "src/api/schema.gql",
    "prisma/schema.prisma",
    "schemas/event.schema.json",
    "db/migrations/0003_ledger.sql",
    "prisma/migrations/0001_init/migration.sql",
    "alembic/versions/abc_add.py",
    "schema/tables.sql",
    ".env.production",
    ".envrc",
    "src/env.ts",
    // B1: doc stems are docs only without an extension or with a doc extension.
    "src/auth/security.ts",
    "src/security.service.ts",
    "billing/license.ts",
    "funding.ts",
    "router/history.ts",
    "models/history.rb",
    "diff/changes.ts",
    "notice.ts",
    "readme.ts",
    "src/changelog/generator.ts",
    // S1: tool stems are tooling only as configuration files.
    "semgrep.ts",
    "snyk.ts",
    "codecov.ts",
    "renovate.ts",
    "parcel.ts",
    "zap.go",
    "karma.ts",
    "lib/jest.ts",
    "babel.ts",
    "sonar.ts",
    "nx.ts",
    "turbo.ts",
    "mocha.ts",
    "c8.ts",
    "src/vite.ts",
    "src/eslint.ts",
    // S2: `requirements` is a manifest only as requirements*.txt|in.
    "src/requirements.ts",
    "src/requirements/checker.py",
    // S3: `*Test.java`-style suffixes need a boundary.
    "Contest.java",
    "Latest.kt",
    "Attest.swift",
    "Greatest.cs",
    "Protest.scala",
    "src/contest.java",
    // S4: directory rules are anchored to the repository root or a package root.
    "src/agent/tools/search.ts",
    "cmd/tools/main.go",
    "src/integrations/ci/runner.ts",
    "src/editor/doc/model.ts",
    "src/docs/generator.ts",
    "app/fixtures/seed.ts",
    "src/fixtures/ledger.json",
    "lib/scripts/runner.rb",
    "app/services/ci/status.rb",
    "api/spec/openapi.yaml",
    "test/openapi.yaml",
    "tests/fixtures/schema.sql",
    "tests/fixtures/migrations/0001.sql",
    "src/agent/tools/README.ts",
  ],
  test: [
    "src/billing/ledger.test.ts",
    "src/billing/__tests__/ledger.ts",
    "tests/ledger.py",
    "test/ledger_test.go",
    "spec/models/user_spec.rb",
    "e2e/checkout.e2e.spec.ts",
    "src/__fixtures__/ledger.json",
    "src/__mocks__/forge.ts",
    "src/__snapshots__/ledger.test.ts.snap",
    "src/ledger.snap",
    "testdata/ledger.golden",
    "test-data/ledger.csv",
    "tests/conftest.py",
    "tests/test_ledger.py",
    "src/main/test/LedgerTest.java",
    "LedgerTests.cs",
    "internal/ledger/testdata/golden.json",
    "accounts/tests.py",
    "Ledger.Tests.cs",
    "ledger_test.kt",
    "src/ledger_spec.php",
    "cypress/e2e/checkout.cy.ts",
    "src/auth/__tests__/README.md",
    "src/auth/__tests__/openapi.yaml",
    "src/orders/__mocks__/forge.ts",
    "packages/schema/fixtures/pr-847.json",
    "fixtures/users.yml",
    "spec/fixtures/users.yml",
    "apps/web/testdata/golden.txt",
  ],
  docs: [
    "README.md",
    "docs/architecture.md",
    "docs/adr/0021-change-map-renderer.md",
    "doc/guide.rst",
    "CHANGELOG.md",
    "CHANGES.txt",
    "LICENSE",
    "LICENCE.txt",
    "NOTICE",
    "CODEOWNERS",
    ".changeset/brave-foxes.md",
    "scripts/README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "AUTHORS",
    "guide.mdx",
    "notes.adoc",
    "src/billing/README.md",
    ".env.example",
    ".env.sample",
    "CITATION.cff",
    ".mailmap",
    "LICENSE-MIT",
    "README-dev",
    "README.rst",
    "packages/core/docs/ports.md",
    "packages/core/adr/0001.md",
    "apps/web/src/notes.txt",
  ],
  tooling: [
    "package.json",
    "apps/web/package.json",
    "pnpm-workspace.yaml",
    ".npmrc",
    ".nvmrc",
    ".node-version",
    ".tool-versions",
    ".editorconfig",
    ".gitignore",
    ".gitattributes",
    ".dockerignore",
    ".prettierrc",
    ".prettierrc.json",
    "prettier.config.js",
    ".prettierignore",
    ".eslintrc.cjs",
    "eslint.config.js",
    ".eslintignore",
    "tsconfig.json",
    "tsconfig.base.json",
    "packages/core/tsconfig.build.json",
    "jsconfig.json",
    "babel.config.js",
    ".babelrc",
    "rollup.config.mjs",
    "webpack.config.js",
    "vite.config.ts",
    "vitest.config.ts",
    "vitest.workspace.ts",
    "jest.config.js",
    "jest.config.cjs",
    "playwright.config.ts",
    "cypress.config.ts",
    ".mocharc.yml",
    "tsup.config.ts",
    "esbuild.config.mjs",
    "turbo.json",
    "nx.json",
    "lerna.json",
    "commitlint.config.js",
    ".commitlintrc.json",
    "lint-staged.config.js",
    ".lintstagedrc",
    ".husky/pre-commit",
    "stylelint.config.js",
    "knip.json",
    "biome.json",
    "tailwind.config.js",
    "postcss.config.js",
    "renovate.json",
    ".renovaterc",
    "codecov.yml",
    ".changeset/config.json",
    "sonar-project.properties",
    ".gitleaks.toml",
    "gitleaks.toml",
    ".semgrep.yml",
    "semgrep.yml",
    ".semgrepignore",
    ".trivyignore",
    ".snyk",
    ".hadolint.yaml",
    ".markdownlint.json",
    ".yamllint",
    "cspell.json",
    ".shellcheckrc",
    "actionlint.yaml",
    ".pre-commit-config.yaml",
    "pyproject.toml",
    "setup.cfg",
    "setup.py",
    "tox.ini",
    "pytest.ini",
    ".flake8",
    "mypy.ini",
    "ruff.toml",
    "requirements.txt",
    "requirements-dev.txt",
    "Pipfile",
    "Cargo.toml",
    "go.mod",
    "Gemfile",
    ".rubocop.yml",
    ".golangci.yml",
    "Makefile",
    "justfile",
    "Taskfile.yml",
    "build.gradle.kts",
    "settings.gradle",
    "pom.xml",
    "Api.csproj",
    "Rocky.sln",
    ".vscode/settings.json",
    ".idea/workspace.xml",
    ".devcontainer/devcontainer.json",
    "scripts/evals.ts",
    "scripts/security/gitleaks.sh",
    "tools/release.sh",
    "scripts/ci/publish.sh",
    "packages/core/scripts/gen.ts",
    "apps/web/tools/icons.mjs",
    "pnpm-lock.yaml",
    "go.sum",
    "Gemfile.lock",
    "nest-cli.json",
    "jest.setup.ts",
    "vitest.setup.ts",
    "karma.conf.js",
    "gulpfile.js",
    "requirements.in",
    "requirements-dev.in",
  ],
  ci: [
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    ".github/dependabot.yml",
    ".github/ISSUE_TEMPLATE/bug.md",
    ".github/CODEOWNERS",
    ".gitlab-ci.yml",
    ".gitlab/merge_request_templates/default.md",
    ".circleci/config.yml",
    ".travis.yml",
    "azure-pipelines.yml",
    "Jenkinsfile",
    "bitbucket-pipelines.yml",
    ".buildkite/pipeline.yml",
    ".drone.yml",
    "appveyor.yml",
    "cloudbuild.yaml",
    "ci/build.sh",
    ".ci/test.sh",
    "packages/core/ci/test.sh",
    "apps/web/.github/workflows/x.yml",
  ],
};

describe("mapCategory", () => {
  for (const [category, paths] of Object.entries(cases) as [MapCategory, string[]][]) {
    it.each(paths)(`%s is ${category}`, (path) => {
      expect(mapCategory(path)).toBe(category);
    });
  }

  it("is case-insensitive", () => {
    expect(mapCategory("README.MD")).toBe("docs");
    expect(mapCategory("Readme.md")).toBe("docs");
    expect(mapCategory("src/Ledger.Test.ts")).toBe("test");
    expect(mapCategory("TSConfig.json")).toBe("tooling");
    expect(mapCategory("DOCKERFILE")).toBe("logic");
  });

  it("runtime definitions win over the directory they sit in", () => {
    // A migration, an API definition or deploy config is mapped wherever it lives.
    expect(mapCategory("docs/openapi.yaml")).toBe("logic");
    expect(mapCategory("scripts/db/migrations/0001.sql")).toBe("logic");
    expect(mapCategory("tools/deploy/Dockerfile")).toBe("logic");
  });

  it("a definition by name wins over a test directory, but not over __tests__ (S4)", () => {
    expect(mapCategory("api/spec/openapi.yaml")).toBe("logic");
    expect(mapCategory("tests/fixtures/schema.sql")).toBe("logic");
    expect(mapCategory("src/auth/__tests__/openapi.yaml")).toBe("test");
    expect(mapCategory("src/auth/__tests__/README.md")).toBe("test");
  });

  it("directory rules apply only at the repository root or a package root (S4)", () => {
    expect(mapCategory("tools/release.sh")).toBe("tooling");
    expect(mapCategory("packages/core/tools/gen.ts")).toBe("tooling");
    expect(mapCategory("src/agent/tools/search.ts")).toBe("logic");
    expect(mapCategory("cmd/tools/main.go")).toBe("logic");
    expect(mapCategory("ci/build.sh")).toBe("ci");
    expect(mapCategory("src/integrations/ci/runner.ts")).toBe("logic");
    expect(mapCategory("docs/guide.html")).toBe("docs");
    expect(mapCategory("src/docs/generator.ts")).toBe("logic");
    expect(mapCategory("src/editor/doc/model.ts")).toBe("logic");
    expect(mapCategory("fixtures/users.yml")).toBe("test");
    expect(mapCategory("app/fixtures/seed.ts")).toBe("logic");
    expect(mapCategory("spec/fixtures/users.yml")).toBe("test");
  });

  it("a doc stem is a doc only without an extension or with a doc extension (B1)", () => {
    expect(mapCategory("SECURITY")).toBe("docs");
    expect(mapCategory("SECURITY.md")).toBe("docs");
    expect(mapCategory("security.ts")).toBe("logic");
    expect(mapCategory("LICENSE")).toBe("docs");
    expect(mapCategory("LICENSE.txt")).toBe("docs");
    expect(mapCategory("license.ts")).toBe("logic");
    expect(mapCategory("history.rb")).toBe("logic");
  });

  it("a tool stem is tooling only as a configuration file (S1)", () => {
    expect(mapCategory("jest.config.ts")).toBe("tooling");
    expect(mapCategory(".jestrc")).toBe("tooling");
    expect(mapCategory("jest.json")).toBe("tooling");
    expect(mapCategory("lib/jest.ts")).toBe("logic");
    expect(mapCategory("semgrep.yml")).toBe("tooling");
    expect(mapCategory("semgrep.ts")).toBe("logic");
    expect(mapCategory("vitest.workspace.ts")).toBe("tooling");
    expect(mapCategory("vitest.ts")).toBe("logic");
  });

  it("CI wins over the tooling and docs rules inside its directories", () => {
    expect(mapCategory(".github/workflows/README.md")).toBe("ci");
    expect(mapCategory(".github/package.json")).toBe("ci");
  });

  it("never throws, is deterministic, and reads only the path (hostile and huge paths)", () => {
    const categories: MapCategory[] = ["logic", "test", "docs", "tooling", "ci"];
    fc.assert(
      fc.property(fc.string({ maxLength: 2_000 }), (path) => {
        const first = mapCategory(path);
        expect(categories).toContain(first);
        expect(mapCategory(path)).toBe(first);
      }),
    );
    // Repeated markers must not make the scan slow (no backtracking): a generous bound, since
    // the real guard is structural (anchored regexes, set lookups, one infix scan).
    const started = performance.now();
    for (const path of [
      `${".test.".repeat(400)}x`,
      `${"a/".repeat(2_000)}x.test.ts`,
      `${"README.md/".repeat(500)}x`,
      `${"Test".repeat(500)}.java`,
      `${"eslint.".repeat(500)}config.js`,
    ])
      mapCategory(path);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

const mappable = (...paths: string[]) => paths.map((path) => ({ path, mappable: true }));

describe("changeMapScope", () => {
  it("maps the logic files and leaves tests, docs, tooling and CI out", () => {
    expect(
      changeMapScope(
        mappable(
          "README.md",
          "src/billing/ledger.ts",
          "src/billing/ledger.test.ts",
          ".github/workflows/ci.yml",
          "eslint.config.js",
          "src/billing/port.ts",
        ),
      ),
    ).toEqual({ kind: "logic", paths: ["src/billing/ledger.ts", "src/billing/port.ts"] });
  });

  it("keeps the caller's order", () => {
    expect(changeMapScope(mappable("b.ts", "README.md", "a.ts"))).toEqual({
      kind: "logic",
      paths: ["b.ts", "a.ts"],
    });
  });

  it("a logic file with an ordinary name next to a README is logic, not no-logic (B1)", () => {
    expect(changeMapScope(mappable("src/security.ts", "README.md"))).toEqual({
      kind: "logic",
      paths: ["src/security.ts"],
    });
    expect(changeMapScope(mappable("lib/jest.ts", "CHANGELOG.md"))).toEqual({
      kind: "logic",
      paths: ["lib/jest.ts"],
    });
  });

  it("maps a test-only pull request from its tests", () => {
    expect(
      changeMapScope(
        mappable("src/billing/ledger.test.ts", "README.md", "spec/fixtures/ledger.json"),
      ),
    ).toEqual({
      kind: "tests",
      paths: ["src/billing/ledger.test.ts", "spec/fixtures/ledger.json"],
    });
  });

  it("has nothing to map for a docs-only, tooling-only or CI-only pull request", () => {
    expect(changeMapScope(mappable("README.md", "docs/adr/0001.md"))).toEqual({ kind: "none" });
    expect(changeMapScope(mappable("package.json", "tsconfig.json"))).toEqual({ kind: "none" });
    expect(changeMapScope(mappable(".github/workflows/ci.yml"))).toEqual({ kind: "none" });
    expect(changeMapScope([])).toEqual({ kind: "none" });
  });

  it("keeps runtime config and schema next to the code that reads them", () => {
    expect(changeMapScope(mappable("db/migrations/0003.sql", "openapi.yaml", "README.md"))).toEqual(
      { kind: "logic", paths: ["db/migrations/0003.sql", "openapi.yaml"] },
    );
  });

  it("logic that cannot be sent makes the map unmappable, never a map of the tests (S5)", () => {
    const files = [
      { path: "src/big.ts", mappable: false },
      { path: "src/big.test.ts", mappable: true },
      { path: "README.md", mappable: true },
    ];
    expect(changeMapScope(files)).toEqual({
      kind: "unmappable",
      category: "logic",
      paths: ["src/big.ts"],
    });
    // Some logic is mappable: only that is sent.
    expect(changeMapScope([...files, { path: "src/small.ts", mappable: true }])).toEqual({
      kind: "logic",
      paths: ["src/small.ts"],
    });
    // The same rule for a test-only PR.
    expect(
      changeMapScope([
        { path: "src/big.test.ts", mappable: false },
        { path: "README.md", mappable: true },
      ]),
    ).toEqual({ kind: "unmappable", category: "tests", paths: ["src/big.test.ts"] });
  });
});
