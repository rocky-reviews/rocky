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
    "src/env.ts",
  ],
  test: [
    "src/billing/ledger.test.ts",
    "src/billing/__tests__/ledger.ts",
    "tests/ledger.py",
    "test/ledger_test.go",
    "spec/models/user_spec.rb",
    "e2e/checkout.e2e.spec.ts",
    "src/fixtures/ledger.json",
    "src/__fixtures__/ledger.json",
    "src/__mocks__/forge.ts",
    "src/__snapshots__/ledger.test.ts.snap",
    "src/ledger.snap",
    "testdata/ledger.golden",
    "test-data/ledger.csv",
    "tests/fixtures/schema.sql",
    "tests/conftest.py",
    "tests/test_ledger.py",
    "src/main/test/LedgerTest.java",
    "LedgerTests.cs",
    "cypress/e2e/checkout.cy.ts",
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
    "pnpm-lock.yaml",
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
    "scripts/ci/publish.sh",
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

  it("tests win over everything, so a fixture migration is a test", () => {
    expect(mapCategory("tests/fixtures/migrations/0001.sql")).toBe("test");
    expect(mapCategory("src/auth/__tests__/README.md")).toBe("test");
    expect(mapCategory("test/openapi.yaml")).toBe("test");
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
    // Repeated markers must not make the scan slow (no backtracking).
    const started = performance.now();
    mapCategory(`${".test.".repeat(400)}x`);
    mapCategory(`${"a/".repeat(2_000)}x.test.ts`);
    mapCategory(`${"README.md/".repeat(500)}x`);
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("changeMapScope", () => {
  it("maps the logic files and leaves tests, docs, tooling and CI out", () => {
    expect(
      changeMapScope([
        "README.md",
        "src/billing/ledger.ts",
        "src/billing/ledger.test.ts",
        ".github/workflows/ci.yml",
        "eslint.config.js",
        "src/billing/port.ts",
      ]),
    ).toEqual({ kind: "logic", paths: ["src/billing/ledger.ts", "src/billing/port.ts"] });
  });

  it("keeps the caller's order", () => {
    expect(changeMapScope(["b.ts", "README.md", "a.ts"])).toEqual({
      kind: "logic",
      paths: ["b.ts", "a.ts"],
    });
  });

  it("maps a test-only pull request from its tests", () => {
    expect(
      changeMapScope(["src/billing/ledger.test.ts", "README.md", "tests/fixtures/ledger.json"]),
    ).toEqual({
      kind: "tests",
      paths: ["src/billing/ledger.test.ts", "tests/fixtures/ledger.json"],
    });
  });

  it("has nothing to map for a docs-only, tooling-only or CI-only pull request", () => {
    expect(changeMapScope(["README.md", "docs/adr/0001.md"])).toEqual({ kind: "none" });
    expect(changeMapScope(["package.json", "tsconfig.json"])).toEqual({ kind: "none" });
    expect(changeMapScope([".github/workflows/ci.yml"])).toEqual({ kind: "none" });
    expect(changeMapScope([])).toEqual({ kind: "none" });
  });

  it("keeps runtime config and schema next to the code that reads them", () => {
    expect(changeMapScope(["db/migrations/0003.sql", "openapi.yaml", "README.md"])).toEqual({
      kind: "logic",
      paths: ["db/migrations/0003.sql", "openapi.yaml"],
    });
  });
});
