import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FORGE_EVENT_TYPES,
  ForgeReadError,
  isForgeEventType,
  isInstallationEvent,
  isPullRequestEvent,
  type ForgeEvent,
} from "./forge.js";

const SRC = new URL("./", import.meta.url);
const PACKAGE_JSON = new URL("../package.json", import.meta.url);

describe("forge event types", () => {
  it("covers installation created/deleted and the four pull request actions", () => {
    expect([...FORGE_EVENT_TYPES].sort()).toEqual([
      "installation.created",
      "installation.deleted",
      "pull_request.closed",
      "pull_request.opened",
      "pull_request.reopened",
      "pull_request.synchronize",
    ]);
  });

  it("recognises only known event types", () => {
    for (const type of FORGE_EVENT_TYPES) expect(isForgeEventType(type)).toBe(true);
    for (const value of ["installation", "pull_request.labeled", "", "PING", 1, null, undefined]) {
      expect(isForgeEventType(value), String(value)).toBe(false);
    }
  });

  it("tells installation events from pull request events", () => {
    const installation: ForgeEvent = {
      type: "installation.deleted",
      installationId: 1,
      account: { id: 2, login: "acme", kind: "organization" },
      sender: { id: 5, login: "alice" },
    };
    const pr: ForgeEvent = {
      type: "pull_request.opened",
      installationId: 1,
      repositoryId: 3,
      number: 4,
      headSha: "a".repeat(40),
      merged: false,
    };
    expect(isInstallationEvent(installation)).toBe(true);
    expect(isInstallationEvent(pr)).toBe(false);
    expect(isPullRequestEvent(pr)).toBe(true);
    expect(isPullRequestEvent(installation)).toBe(false);
  });
});

/**
 * P3-7: core is forge-neutral. The ESLint allowlist (eslint.config.js, scripts/lint-rules.test.ts)
 * is the first guard; this one reads the sources and the manifest directly, so it holds even if
 * the lint config is edited.
 */
describe("core forge neutrality (P3-7)", () => {
  const sources = readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(f) && !/\.test\./.test(f))
    .map((f) => ({ file: f, text: readFileSync(new URL(f, SRC), "utf8") }));
  const SPECIFIER =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|\bexport\s[^;]*?\bfrom\s*)["']([^"']+)["']/g;

  it("finds the production sources", () => {
    expect(sources.map((s) => s.file)).toContain("forge.ts");
  });

  it("imports nothing from Octokit, a forge adapter or any other package", () => {
    for (const { file, text } of sources) {
      for (const match of text.matchAll(SPECIFIER)) {
        const specifier = match[1]!;
        expect(specifier, `${file}: ${specifier}`).not.toMatch(/octokit|github|gitlab|gitea/i);
        // Only core's own files (and zod / the shared schema, per the ESLint allowlist).
        expect(
          specifier.startsWith("./") ||
            specifier === "zod" ||
            specifier === "@rocky-reviews/schema",
          `${file}: ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("declares no Octokit or forge adapter dependency", () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as Record<string, unknown>;
    const deps = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
      .flatMap((k) => Object.keys((manifest[k] as Record<string, string> | undefined) ?? {}))
      .join(" ");
    expect(deps).not.toMatch(/octokit|forge-github|github|gitlab|gitea/i);
  });
});

describe("ForgeReadError (P3-3)", () => {
  it("carries a fixed code and never anything else", () => {
    expect(new ForgeReadError("timeout").code).toBe("forge_timeout");
    expect(new ForgeReadError("http_status", 502).code).toBe("forge_http_502");
    expect(new ForgeReadError("http_status").code).toBe("forge_http_status");
    expect(new ForgeReadError("unsupported_account_type").code).toBe(
      "forge_unsupported_account_type",
    );
    const error = new ForgeReadError("http_status", 401);
    expect(error.message).toBe("forge read failed: http_status 401");
    expect(Object.keys(error).sort()).toEqual(["name", "reason", "status"]);
  });

  it("tells an outage from a bad answer (review round 1, S3)", () => {
    // Transient: the forge or the path to it is unavailable, or our credentials are (a rotated
    // or revoked key is an operator problem, not a property of the event).
    for (const error of [
      new ForgeReadError("timeout"),
      new ForgeReadError("network"),
      new ForgeReadError("http_status", 401),
      new ForgeReadError("http_status", 403),
      new ForgeReadError("http_status", 429),
      new ForgeReadError("http_status", 500),
      new ForgeReadError("http_status", 502),
      new ForgeReadError("http_status", 503),
      new ForgeReadError("app_mismatch"),
    ]) {
      expect(error.transient, error.code).toBe(true);
    }
    // Not transient: the answer itself is wrong or unusable; retrying it forever would not help.
    for (const error of [
      new ForgeReadError("invalid_response"),
      new ForgeReadError("unsupported_account_type"),
      new ForgeReadError("http_status", 302),
      new ForgeReadError("http_status", 410),
      new ForgeReadError("http_status", 422),
      new ForgeReadError("http_status"),
    ]) {
      expect(error.transient, error.code).toBe(false);
    }
    expect(new ForgeReadError("app_mismatch").code).toBe("forge_app_mismatch");
  });
});
