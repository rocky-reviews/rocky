import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, webhookSecretFromEnv } from "./config.js";

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
