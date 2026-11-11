import { describe, expect, it } from "vitest";
import {
  ConfigError,
  connectionModeFromEnv,
  GITHUB_APP_VARIABLES,
  setupFromEnv,
  tokenModeFromEnv,
  tokenModePublicUrl,
} from "../config.js";

/** P10-4 (ADR 0045 §1, §2): how a server connects to GitHub, and token mode's own rules. */

const TOKEN = { ROCKY_GITHUB_CONNECTION: "token" };

describe("connectionModeFromEnv", () => {
  it("is the App unless token mode is asked for exactly", () => {
    expect(connectionModeFromEnv({})).toBe("app");
    expect(connectionModeFromEnv({ ROCKY_GITHUB_CONNECTION: "" })).toBe("app");
    expect(connectionModeFromEnv({ ROCKY_GITHUB_CONNECTION: "app" })).toBe("app");
    expect(connectionModeFromEnv(TOKEN)).toBe("token");
    for (const bad of ["TOKEN", "pat", "token ", "1"]) {
      expect(() => connectionModeFromEnv({ ROCKY_GITHUB_CONNECTION: bad })).toThrow(ConfigError);
    }
  });

  it("is refused on Fly.io (Rocky Cloud), whatever else is set", () => {
    for (const extra of [{}, { NODE_ENV: "development" }, { ROCKY_SETUP: "true" }]) {
      expect(() =>
        connectionModeFromEnv({ ...TOKEN, ...extra, FLY_APP_NAME: "rocky-cloud" }),
      ).toThrow(/refused on Fly\.io/);
    }
    // The App path is untouched there.
    expect(connectionModeFromEnv({ FLY_APP_NAME: "rocky-cloud" })).toBe("app");
  });
});

describe("tokenModePublicUrl", () => {
  it("accepts https anywhere and http on loopback, even in production (nothing leaves the host)", () => {
    expect(tokenModePublicUrl({ ROCKY_PUBLIC_URL: "https://rocky.example.com" }).href).toBe(
      "https://rocky.example.com/",
    );
    for (const url of ["http://127.0.0.1:4310", "http://localhost:4310", "http://[::1]:4310"]) {
      expect(tokenModePublicUrl({ NODE_ENV: "production", ROCKY_PUBLIC_URL: url }).protocol).toBe(
        "http:",
      );
    }
  });

  it("refuses http elsewhere, a path, credentials, and a missing URL in production", () => {
    for (const url of [
      "http://rocky.example.com",
      "http://10.0.0.5:4310",
      "http://127.0.0.1.nip.io",
      "https://rocky.example.com/rocky",
      "https://user:pass@rocky.example.com",
      "ftp://127.0.0.1",
    ]) {
      expect(() => tokenModePublicUrl({ ROCKY_PUBLIC_URL: url }), url).toThrow(ConfigError);
    }
    expect(() => tokenModePublicUrl({ NODE_ENV: "production" })).toThrow(/ROCKY_PUBLIC_URL/);
    expect(tokenModePublicUrl({ HOST: "127.0.0.1", PORT: "5000" }).href).toBe(
      "http://127.0.0.1:5000/",
    );
  });
});

describe("tokenModeFromEnv", () => {
  it("refuses every GitHub App variable: one connection, one source of truth", () => {
    for (const name of GITHUB_APP_VARIABLES) {
      expect(() => tokenModeFromEnv({ ...TOKEN, [name]: "x" }), name).toThrow(
        new RegExp(`^${name} must be unset`),
      );
    }
  });

  it("needs the session secret in production, and reads ROCKY_ANALYSIS_AUTO", () => {
    expect(() =>
      tokenModeFromEnv({
        ...TOKEN,
        NODE_ENV: "production",
        ROCKY_PUBLIC_URL: "http://127.0.0.1:4310",
      }),
    ).toThrow(/ROCKY_SESSION_SECRET is required/);
    expect(() =>
      tokenModeFromEnv({ ...TOKEN, HOST: "127.0.0.1", ROCKY_SESSION_SECRET: "short" }),
    ).toThrow(/ROCKY_SESSION_SECRET must be/);
    const config = tokenModeFromEnv({
      ...TOKEN,
      NODE_ENV: "production",
      ROCKY_PUBLIC_URL: "http://127.0.0.1:4310",
      ROCKY_SESSION_SECRET: "s".repeat(40),
      ROCKY_ANALYSIS_AUTO: "on",
    });
    expect(config).toMatchObject({ cookieSecure: false, production: true, analysisAuto: true });
    expect(config.endpoints.api.href).toBe("https://api.github.com/");
    expect(() =>
      tokenModeFromEnv({ ...TOKEN, HOST: "127.0.0.1", ROCKY_ANALYSIS_AUTO: "yes" }),
    ).toThrow(/ROCKY_ANALYSIS_AUTO must be on or off/);
  });
});

describe("setupFromEnv in token mode", () => {
  it("opens the wizard without the App manifest flow, on loopback http in production", () => {
    const setup = setupFromEnv(
      {
        ...TOKEN,
        ROCKY_SETUP: "true",
        NODE_ENV: "production",
        ROCKY_PUBLIC_URL: "http://127.0.0.1:4310",
      },
      "/home/rocky",
    );
    expect(setup).toMatchObject({
      enabled: true,
      appConfigured: false,
      githubApp: { enabled: false, reason: "token_mode" },
    });
  });
});
