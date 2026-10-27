import { llmConfigFromEnv } from "@rocky-reviews/llm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rsaPrivateKeyPem, testAppKeys } from "@rocky-reviews/forge-github/testing";
import { describe, expect, it } from "vitest";
import {
  analysisConfigFromEnv,
  ConfigError,
  databaseLoginHint,
  DEFAULT_ANALYSIS_CONFIG,
  githubAppFromEnv,
  loadWorkerConfig,
  workerConfigFromEnv,
} from "./config.js";

/** P3-3: the worker validates its app credentials before it opens anything, and fails closed. */

const keys = testAppKeys();
const DB = "postgres://worker:pw@127.0.0.1:1/none";

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError");
};

describe("githubAppFromEnv", () => {
  it("parses valid credentials and the default API base", () => {
    const app = githubAppFromEnv({
      GITHUB_APP_ID: "42",
      GITHUB_APP_PRIVATE_KEY: keys.privateKeyPem,
    });
    expect(app?.auth.appId).toBe(42);
    expect(app?.api.href).toBe("https://api.github.com/");
  });

  it("uses a GitHub Enterprise Server API base, https only", () => {
    const env = { GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: keys.privateKeyPem };
    expect(githubAppFromEnv({ ...env, GITHUB_URL: "https://ghe.example.com" })?.api.href).toBe(
      "https://ghe.example.com/api/v3/",
    );
    expect(
      messageOf(() => githubAppFromEnv({ ...env, GITHUB_API_URL: "http://api.example.com" })),
    ).toMatch(/https/);
  });

  it("is required in production (NODE_ENV or Fly.io), optional elsewhere", () => {
    for (const env of [{ NODE_ENV: "production" }, { FLY_APP_NAME: "rocky" }]) {
      expect(messageOf(() => githubAppFromEnv(env))).toMatch(/required in production/);
    }
    expect(githubAppFromEnv({})).toBeUndefined();
    expect(githubAppFromEnv({ GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "" })).toBeUndefined();
  });

  it("refuses half a configuration and bad values everywhere, never echoing the key", () => {
    const small = rsaPrivateKeyPem(1024);
    for (const env of [
      { GITHUB_APP_ID: "42" },
      { GITHUB_APP_PRIVATE_KEY: keys.privateKeyPem },
      { GITHUB_APP_ID: "abc", GITHUB_APP_PRIVATE_KEY: keys.privateKeyPem },
      { GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: small },
      { GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n" },
    ]) {
      for (const NODE_ENV of ["production", "development"]) {
        const message = messageOf(() => githubAppFromEnv({ ...env, NODE_ENV }));
        expect(message).toMatch(/^GITHUB_APP_/);
        expect(message).not.toContain("BEGIN");
        expect(message).not.toContain(keys.privateKeyPem.slice(60, 100));
      }
    }
  });
});

describe("workerConfigFromEnv", () => {
  it("requires the worker's own database login", () => {
    expect(messageOf(() => workerConfigFromEnv({ DATABASE_URL: DB }))).toMatch(
      /WORKER_DATABASE_URL is required/,
    );
    expect(workerConfigFromEnv({ WORKER_DATABASE_URL: DB })).toEqual({
      databaseUrl: DB,
      githubApp: undefined,
      llm: llmConfigFromEnv({}),
      analysis: DEFAULT_ANALYSIS_CONFIG,
    });
  });

  it("validates the LLM roles at boot (P4-3): a bad ROCKY_LLM_* stops the worker, naming the variable only", () => {
    const message = messageOf(() =>
      workerConfigFromEnv({
        WORKER_DATABASE_URL: DB,
        ROCKY_LLM_REVIEW_MODEL: "gpt-oops-secretish",
      }),
    );
    expect(message).toMatch(/ROCKY_LLM_REVIEW_MODEL/);
    expect(
      messageOf(() => workerConfigFromEnv({ WORKER_DATABASE_URL: DB, ROCKY_LLM_TYPO: "x" })),
    ).toMatch(/ROCKY_LLM_TYPO: unknown variable/);
  });
});

describe("analysisConfigFromEnv (P4-6)", () => {
  it("defaults: automatic analysis off, a 150 000-token per-PR limit, 4 per worker, 2 per org", () => {
    expect(analysisConfigFromEnv({})).toEqual({
      auto: false,
      tokenLimit: 150_000,
      concurrency: 4,
      orgConcurrency: 2,
    });
    expect(workerConfigFromEnv({ WORKER_DATABASE_URL: DB }).analysis).toEqual(
      DEFAULT_ANALYSIS_CONFIG,
    );
  });

  it("reads ROCKY_ANALYSIS_*, empty counting as unset", () => {
    expect(
      analysisConfigFromEnv({
        ROCKY_ANALYSIS_TOKEN_LIMIT: "300000",
        ROCKY_ANALYSIS_CONCURRENCY: "8",
        ROCKY_ANALYSIS_ORG_CONCURRENCY: "",
      }),
    ).toEqual({ auto: false, tokenLimit: 300_000, concurrency: 8, orgConcurrency: 2 });
    expect(analysisConfigFromEnv({ ROCKY_ANALYSIS_AUTO: "on" }).auto).toBe(true);
    expect(analysisConfigFromEnv({ ROCKY_ANALYSIS_AUTO: "off" }).auto).toBe(false);
    expect(analysisConfigFromEnv({ ROCKY_ANALYSIS_AUTO: "" }).auto).toBe(false);
  });

  it.each([
    ["ROCKY_ANALYSIS_TOKEN_LIMIT", "999"],
    ["ROCKY_ANALYSIS_TOKEN_LIMIT", "1e6"],
    ["ROCKY_ANALYSIS_TOKEN_LIMIT", "-5"],
    ["ROCKY_ANALYSIS_CONCURRENCY", "0"],
    ["ROCKY_ANALYSIS_CONCURRENCY", "33"],
    ["ROCKY_ANALYSIS_ORG_CONCURRENCY", "two"],
    ["ROCKY_ANALYSIS_ORG_CONCURRENCY", "1.5"],
    ["ROCKY_ANALYSIS_AUTO", "yes"],
    ["ROCKY_ANALYSIS_AUTO", "ON"],
  ])("refuses %s=%s, naming the variable only", (name, value) => {
    const message = messageOf(() =>
      workerConfigFromEnv({ WORKER_DATABASE_URL: DB, [name]: value }),
    );
    expect(message).toContain(name);
    expect(message).not.toContain(`=${value}`);
  });
});

describe("loadWorkerConfig (review round 1, L6)", () => {
  it("removes the private key from the environment once it is parsed", () => {
    const env: Record<string, string | undefined> = {
      WORKER_DATABASE_URL: DB,
      GITHUB_APP_ID: "42",
      GITHUB_APP_PRIVATE_KEY: keys.privateKeyPem,
    };
    const config = loadWorkerConfig(env);
    expect(config.githubApp?.auth.appId).toBe(42);
    expect("GITHUB_APP_PRIVATE_KEY" in env).toBe(false);
    expect(env["GITHUB_APP_ID"]).toBe("42");
    // The parsed key still signs (it lives in a KeyObject, not in the environment).
    expect(config.githubApp?.auth.privateKey.type).toBe("private");
  });

  it("leaves the environment alone when parsing fails (the process exits anyway)", () => {
    const env: Record<string, string | undefined> = {
      GITHUB_APP_ID: "42",
      GITHUB_APP_PRIVATE_KEY: keys.privateKeyPem,
    };
    expect(() => loadWorkerConfig(env)).toThrow(ConfigError);
    expect(env["GITHUB_APP_PRIVATE_KEY"]).toBe(keys.privateKeyPem);
  });
});

describe("databaseLoginHint (review round 1, N4)", () => {
  it("points at pnpm seed for a refused login, and says nothing otherwise", () => {
    for (const code of ["28P01", "28000"]) {
      expect(databaseLoginHint(code)).toMatch(/pnpm seed.*rocky_worker_dev/);
    }
    for (const code of ["ECONNREFUSED", "3D000", "unknown"]) {
      expect(databaseLoginHint(code)).toBeUndefined();
    }
  });
});

describe("main.ts (spawned)", () => {
  const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", MAIN], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
  const fatal = (stdout: string) =>
    stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l["level"] === 60);

  it("refuses to start in production without app credentials, before touching the database", () => {
    const result = run({ WORKER_DATABASE_URL: DB, NODE_ENV: "production" });
    expect(result.status).toBe(1);
    expect(fatal(result.stdout)).toMatchObject({ msg: "invalid configuration" });
    expect(result.stdout + result.stderr).not.toContain("pw@127.0.0.1");
  }, 30_000);

  it("refuses a malformed key without printing it", () => {
    const pem = keys.privateKeyPem.replace("MII", "XXX");
    const result = run({
      WORKER_DATABASE_URL: DB,
      GITHUB_APP_ID: "42",
      GITHUB_APP_PRIVATE_KEY: pem,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(pem.slice(40, 120));
  }, 30_000);

  it("refuses to start without WORKER_DATABASE_URL", () => {
    const result = run({ DATABASE_URL: DB });
    expect(result.status).toBe(1);
    expect(JSON.stringify(fatal(result.stdout))).toMatch(/WORKER_DATABASE_URL/);
  }, 30_000);
});
