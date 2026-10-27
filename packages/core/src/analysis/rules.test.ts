import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyFloor, NOISE_SUMMARIES, preTriage } from "./rules.js";

/**
 * P4-3 rules pre-triage: deterministic, path-only. Lockfiles and generated files are noise (never
 * sent to a model); migrations and auth paths get a floor so a model (or a PR steering one) can
 * never triage them out of review. Security rules win over noise rules.
 */
describe("preTriage", () => {
  it.each([
    "pnpm-lock.yaml",
    "web/package-lock.json",
    "yarn.lock",
    "Cargo.lock",
    "go.sum",
    "poetry.lock",
    "Gemfile.lock",
    "composer.lock",
    "uv.lock",
  ])("%s is a lockfile", (path) => {
    expect(preTriage(path)).toEqual({ kind: "noise", rule: "lockfile" });
  });

  it.each([
    "src/generated/api-types.ts",
    "app/__generated__/schema.graphql.ts",
    "proto/user.pb.go",
    "py/user_pb2.py",
    "lib/model.g.dart",
    "src/types.generated.ts",
    "public/vendor.min.js",
  ])("%s is generated", (path) => {
    expect(preTriage(path)).toEqual({ kind: "noise", rule: "generated" });
  });

  it.each([
    "db/migrations/20261020_add_invitations.sql",
    "prisma/migrations/0001_init/migration.sql",
    "alembic/versions/abc_add.py",
    "db/migrate/20260101_users.rb",
    "schema/tables.sql",
  ])("%s is a migration (floor important)", (path) => {
    expect(preTriage(path)).toEqual({ kind: "analyse", floor: "important", rule: "migration" });
  });

  it.each([
    "src/auth/invitations.ts",
    "src/middleware/requireAuth.ts",
    "lib/oauth/callback.go",
    "app/sessions_controller.rb",
    "src/permissions.ts",
    "pkg/crypto/keys.go",
    "config/secrets.ts",
    "src/lib/jwt.ts",
    "api/login.py",
    "src/acl/rules.ts",
  ])("%s is on an auth path (floor important)", (path) => {
    expect(preTriage(path)).toEqual({ kind: "analyse", floor: "important", rule: "auth" });
  });

  it.each([
    "src/auth/invitations.test.ts",
    "src/auth/__tests__/login.ts",
    "tests/auth/session.py",
    "pkg/auth/token_test.go",
    "src/auth/login.spec.tsx",
  ])("%s is a test: no auth floor", (path) => {
    expect(preTriage(path)).toEqual({ kind: "analyse" });
  });

  it.each(["src/api/routes/invitations.ts", "README.md", "src/processor.ts", "src/author.ts"])(
    "%s has no rule (or a harmless over-match)",
    (path) => {
      const decision = preTriage(path);
      expect(decision.kind).toBe("analyse");
    },
  );

  it("over-matching only ever adds review: an author file gets the auth floor", () => {
    expect(preTriage("src/author.ts")).toMatchObject({ floor: "important" });
  });

  it("security paths are never noise, even when they look generated", () => {
    expect(preTriage("src/generated/auth/session.ts")).toMatchObject({
      kind: "analyse",
      rule: "auth",
    });
    expect(preTriage("db/migrations/generated/0002.sql")).toMatchObject({
      kind: "analyse",
      rule: "migration",
    });
  });

  it("noise summaries are fixed, Rocky-written text that says the AI did not read the file", () => {
    for (const summary of Object.values(NOISE_SUMMARIES)) {
      expect(summary).toMatch(/did not read/);
    }
  });
});

describe("applyFloor", () => {
  const triage = { score: 12, level: "low" as const };

  it("raises a lower level and its score to the floor's band", () => {
    expect(applyFloor(triage, "important")).toEqual({ score: 50, level: "important" });
  });

  it("never lowers a level", () => {
    expect(applyFloor({ score: 97, level: "critical" }, "important")).toEqual({
      score: 97,
      level: "critical",
    });
  });

  it("without a floor, changes nothing", () => {
    expect(applyFloor(triage, undefined)).toBe(triage);
  });
});

describe("name rules without backtracking regexes (CodeQL js/polynomial-redos)", () => {
  // The patterns the scans replaced: kept here as the reference they must agree with.
  const OLD_TEST = /(?:\.(?:test|spec)\.[^/]+|_test\.[^/]+|_spec\.[^/]+)$/;
  const OLD_GENERATED =
    /(?:\.generated\.[^/]+|\.gen\.[^/]+|\.pb\.(?:go|cc|h|swift|dart)|_pb2(?:_grpc)?\.pyi?|\.g\.dart|\.freezed\.dart|\.min\.(?:js|css))$/;
  const name = fc
    .array(fc.constantFrom("a", ".", "_", "test", "spec", "gen", "generated", "pb", "min", "js"), {
      maxLength: 12,
    })
    .map((parts) => parts.join(""));

  it("agrees with the old test-name and generated-name patterns", () => {
    fc.assert(
      fc.property(name, (file) => {
        const path = `src/${file}`;
        const oldTest = OLD_TEST.test(file);
        const oldGenerated = OLD_GENERATED.test(file);
        if (oldGenerated) expect(preTriage(path)).toEqual({ kind: "noise", rule: "generated" });
        else expect(preTriage(path)).not.toEqual({ kind: "noise", rule: "generated" });
        // A test name drops the auth floor: compare on an auth directory.
        const auth = preTriage(`src/auth/${file}`);
        if (oldTest) expect(auth).not.toMatchObject({ rule: "auth" });
        else if (file.length > 0) expect(auth).toMatchObject({ rule: "auth" });
      }),
      { numRuns: 2000 },
    );
  });
});
