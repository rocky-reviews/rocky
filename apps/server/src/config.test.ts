import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rsaPrivateKeyPem, testAppKeys } from "@rocky-reviews/forge-github/testing";
import { ConfigError, githubAppAuthFromEnv, isProduction, webhookSecretFromEnv } from "./config.js";

const GOOD = "0123456789abcdef0123456789abcdef0123456789abcdef";

describe("webhookSecretFromEnv (P3-2)", () => {
  it("returns a valid secret", () => {
    expect(webhookSecretFromEnv({ GITHUB_WEBHOOK_SECRET: GOOD, NODE_ENV: "production" })).toBe(
      GOOD,
    );
  });

  it("requires the secret in production", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "production", GITHUB_WEBHOOK_SECRET: "" },
    ]) {
      expect(() => webhookSecretFromEnv(env)).toThrow(ConfigError);
    }
  });

  it("disables the receiver outside production when unset", () => {
    expect(webhookSecretFromEnv({})).toBeUndefined();
    expect(
      webhookSecretFromEnv({ NODE_ENV: "development", GITHUB_WEBHOOK_SECRET: "" }),
    ).toBeUndefined();
  });

  it("refuses a short or padded secret in every environment, without echoing it", () => {
    for (const secret of ["short-secret-value", ` ${GOOD}`, `${GOOD}\n`]) {
      for (const NODE_ENV of ["production", "development", undefined]) {
        let message = "";
        try {
          webhookSecretFromEnv({ GITHUB_WEBHOOK_SECRET: secret, NODE_ENV });
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigError);
          message = (error as Error).message;
        }
        expect(message).toMatch(/GITHUB_WEBHOOK_SECRET/);
        expect(message).not.toContain(secret.trim());
      }
    }
  });
});

describe("server boot", () => {
  const main = fileURLToPath(new URL("./main.ts", import.meta.url));
  const boot = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["--import", "tsx", main], {
      env: {
        PATH: process.env["PATH"] ?? "",
        // Unroutable on purpose: boot must fail on configuration before touching the network.
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
        PORT: "0",
        HOST: "127.0.0.1",
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    });

  it("fails to boot in production without GITHUB_WEBHOOK_SECRET", () => {
    const result = boot({ NODE_ENV: "production" });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/GITHUB_WEBHOOK_SECRET is required/);
  }, 30_000);

  it("fails to boot with a weak secret and does not print it", () => {
    const weak = "weak-secret-do-not-print";
    const result = boot({ NODE_ENV: "production", GITHUB_WEBHOOK_SECRET: weak });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain(weak);
  }, 30_000);
});

describe("production detection (review round 1, item 5)", () => {
  it("treats NODE_ENV=production or a set FLY_APP_NAME as production", () => {
    expect(isProduction({ NODE_ENV: "production" })).toBe(true);
    expect(isProduction({ FLY_APP_NAME: "rocky-cloud" })).toBe(true);
    expect(isProduction({ NODE_ENV: "development", FLY_APP_NAME: "rocky-cloud" })).toBe(true);
    expect(isProduction({})).toBe(false);
    expect(isProduction({ FLY_APP_NAME: "" })).toBe(false);
    expect(isProduction({ NODE_ENV: "development" })).toBe(false);
  });

  it("requires the secret on Fly.io even when NODE_ENV is unset", () => {
    expect(() => webhookSecretFromEnv({ FLY_APP_NAME: "rocky-cloud" })).toThrow(ConfigError);
    expect(webhookSecretFromEnv({ FLY_APP_NAME: "rocky-cloud", GITHUB_WEBHOOK_SECRET: GOOD })).toBe(
      GOOD,
    );
  });

  it("fails to boot on Fly.io without GITHUB_WEBHOOK_SECRET (spawned main)", () => {
    const main = fileURLToPath(new URL("./main.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", main], {
      env: {
        PATH: process.env["PATH"] ?? "",
        DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
        PORT: "0",
        HOST: "127.0.0.1",
        FLY_APP_NAME: "rocky-cloud",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/GITHUB_WEBHOOK_SECRET is required/);
  }, 30_000);
});

describe("githubAppAuthFromEnv (H4-1: the repository access check needs the app's key)", () => {
  const { privateKeyPem } = testAppKeys();
  const APP = { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: privateKeyPem };

  it("parses the id and the PEM into a KeyObject (the PEM text is not kept)", () => {
    const auth = githubAppAuthFromEnv(APP);
    expect(auth?.appId).toBe(123456);
    expect(auth?.privateKey.asymmetricKeyType).toBe("rsa");
    expect(JSON.stringify(auth)).not.toContain("PRIVATE KEY");
  });

  it("outside production an unset key means no check (the caller logs and routes answer 503)", () => {
    expect(githubAppAuthFromEnv({})).toBeUndefined();
    expect(githubAppAuthFromEnv({ GITHUB_APP_ID: "123456" })).toBeUndefined();
    expect(githubAppAuthFromEnv({ GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: "" })).toBe(
      undefined,
    );
  });

  it("production requires the key (NODE_ENV=production or FLY_APP_NAME)", () => {
    for (const env of [
      { NODE_ENV: "production", GITHUB_APP_ID: "123456" },
      { FLY_APP_NAME: "rocky", GITHUB_APP_ID: "123456" },
    ]) {
      expect(() => githubAppAuthFromEnv(env)).toThrow(ConfigError);
      expect(() => githubAppAuthFromEnv(env)).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    }
    expect(githubAppAuthFromEnv({ NODE_ENV: "production", ...APP })?.appId).toBe(123456);
  });

  it("refuses a key without the app id, and a malformed or short key, without echoing it", () => {
    const cases: Record<string, string | undefined>[] = [
      { GITHUB_APP_PRIVATE_KEY: privateKeyPem },
      { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: "not-a-key-0123456789" },
      { GITHUB_APP_ID: "123456", GITHUB_APP_PRIVATE_KEY: rsaPrivateKeyPem(1024) },
      { GITHUB_APP_ID: "0", GITHUB_APP_PRIVATE_KEY: privateKeyPem },
    ];
    for (const env of cases) {
      let message = "";
      try {
        githubAppAuthFromEnv(env);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message).toMatch(/GITHUB_APP_(ID|PRIVATE_KEY)/);
      const key = env["GITHUB_APP_PRIVATE_KEY"] ?? "";
      expect(message).not.toContain(key.split("\n")[1] ?? key);
    }
  });
});
