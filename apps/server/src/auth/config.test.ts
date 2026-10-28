import { describe, expect, it } from "vitest";
import { authFromEnv, ConfigError } from "../config.js";

/** P7-1 (ADR 0020): login configuration, and the dev-only cookie exception. */

const CLIENT = {
  GITHUB_APP_CLIENT_ID: "Iv23liTestClient01",
  GITHUB_APP_CLIENT_SECRET: "test-only-client-secret-0123456789abcdef",
};
/** Test-only, deliberately low-entropy. */
const SECRET = { ROCKY_SESSION_SECRET: "x".repeat(32) };
const APP = { GITHUB_APP_ID: "123456" };
const PROD = { NODE_ENV: "production", ROCKY_PUBLIC_URL: "https://rocky.example.com" };

describe("authFromEnv", () => {
  it("production: https, Secure cookies, a session secret and the client credentials are required", () => {
    const setup = authFromEnv({ ...PROD, ...CLIENT, ...SECRET, GITHUB_APP_ID: "123456" });
    expect(setup.enabled).toBe(true);
    if (!setup.enabled) return;
    expect(setup.config.cookieSecure).toBe(true);
    expect(setup.config.publicUrl.origin).toBe("https://rocky.example.com");
    expect(setup.config.appId).toBe(123456);
    expect(setup.config.production).toBe(true);
    expect(() => authFromEnv({ ...PROD, ...CLIENT, ...SECRET })).toThrow(/GITHUB_APP_ID/);
    for (const env of [
      { ...PROD, ...SECRET },
      { ...PROD, ...CLIENT },
      // GITHUB_APP_ID is required in production (review round 1).
      { ...PROD, ...CLIENT, ...SECRET },
      { ...PROD, ...CLIENT, ...SECRET, ...APP, ROCKY_PUBLIC_URL: "http://127.0.0.1:4310" },
      { NODE_ENV: "production", ...CLIENT, ...SECRET, ...APP },
      {
        FLY_APP_NAME: "rocky",
        ...CLIENT,
        ...SECRET,
        ...APP,
        ROCKY_PUBLIC_URL: "http://localhost:4310",
      },
    ]) {
      expect(() => authFromEnv(env), JSON.stringify(Object.keys(env))).toThrow(ConfigError);
    }
  });

  it("development: http only on loopback (no Secure, no __Host-); a missing secret is generated later", () => {
    const setup = authFromEnv({ ...CLIENT, HOST: "127.0.0.1", PORT: "4310" });
    expect(setup).toMatchObject({
      enabled: true,
      config: { cookieSecure: false, sessionSecret: undefined },
    });
    expect(() => authFromEnv({ ...CLIENT, ROCKY_PUBLIC_URL: "http://rocky.lan:4310" })).toThrow(
      ConfigError,
    );
    expect(() => authFromEnv({ ...CLIENT, HOST: "0.0.0.0" })).toThrow(ConfigError);
    expect(authFromEnv({})).toEqual({ enabled: false });
  });

  it("refuses half or malformed credentials, a short secret, a path or a query, and never echoes values", () => {
    const bad = [
      { GITHUB_APP_CLIENT_ID: CLIENT.GITHUB_APP_CLIENT_ID },
      { GITHUB_APP_CLIENT_SECRET: CLIENT.GITHUB_APP_CLIENT_SECRET },
      { ...CLIENT, GITHUB_APP_CLIENT_ID: "bad id!" },
      { ...CLIENT, GITHUB_APP_CLIENT_SECRET: "short" },
      { ...CLIENT, ROCKY_SESSION_SECRET: "too-short-secret" },
      { ...CLIENT, ROCKY_SESSION_SECRET: `${"x".repeat(31)} y` },
      { ...CLIENT, ROCKY_PUBLIC_URL: "https://rocky.example.com/app" },
      { ...CLIENT, ROCKY_PUBLIC_URL: "https://rocky.example.com/?x=1" },
      { ...CLIENT, ROCKY_PUBLIC_URL: "https://user:pw@rocky.example.com" },
      { ...CLIENT, ROCKY_PUBLIC_URL: "https://rocky.example.com", GITHUB_APP_ID: "12x" },
      {
        ...CLIENT,
        ROCKY_PUBLIC_URL: "https://rocky.example.com",
        GITHUB_URL: "http://ghe.example.com",
      },
    ];
    for (const env of bad) {
      let message = "";
      try {
        authFromEnv(env);
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(Object.keys(env))).not.toBe("");
      expect(message).not.toContain(CLIENT.GITHUB_APP_CLIENT_SECRET);
      expect(message).not.toContain("too-short-secret");
    }
  });
});
