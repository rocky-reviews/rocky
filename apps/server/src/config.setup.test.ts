import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, githubAppSetupFromEnv } from "./config.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "rocky-home-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const ON = { GITHUB_APP_SETUP: "true", HOST: "127.0.0.1", PORT: "4310" };

describe("githubAppSetupFromEnv (P3-1)", () => {
  it("is off unless explicitly requested", () => {
    expect(githubAppSetupFromEnv({}, home)).toStrictEqual({
      enabled: false,
      reason: "not_requested",
    });
    expect(githubAppSetupFromEnv({ GITHUB_APP_SETUP: "1" }, home)).toStrictEqual({
      enabled: false,
      reason: "not_requested",
    });
  });

  it("refuses to boot when requested in production", () => {
    expect(() => githubAppSetupFromEnv({ ...ON, NODE_ENV: "production" }, home)).toThrow(
      ConfigError,
    );
    expect(() => githubAppSetupFromEnv({ ...ON, FLY_APP_NAME: "rocky" }, home)).toThrow(
      ConfigError,
    );
  });

  it("is off once an app is configured (env or credentials file)", async () => {
    expect(githubAppSetupFromEnv({ ...ON, GITHUB_APP_ID: "1" }, home)).toStrictEqual({
      enabled: false,
      reason: "configured",
    });
    const file = join(home, "creds.env");
    await writeFile(file, "X=1\n");
    expect(githubAppSetupFromEnv({ ...ON, GITHUB_APP_CREDENTIALS_FILE: file }, home)).toStrictEqual(
      {
        enabled: false,
        reason: "configured",
      },
    );
  });

  it("defaults: loopback public URL from HOST/PORT, file under ~/.rocky, github.com", () => {
    const setup = githubAppSetupFromEnv(ON, home);
    expect(setup.enabled).toBe(true);
    if (!setup.enabled) return;
    expect(setup.config.publicUrl.href).toBe("http://127.0.0.1:4310/");
    expect(setup.config.webhookUrl).toBeUndefined();
    expect(setup.config.credentialsFile).toBe(join(home, ".rocky", "github-app.env"));
    expect(setup.config.appName).toBe("Rocky Reviews");
    expect(setup.config.endpoints.api.href).toBe("https://api.github.com/");
  });

  it("derives the webhook URL from an https public URL, or takes an explicit https one", () => {
    const a = githubAppSetupFromEnv({ ...ON, ROCKY_PUBLIC_URL: "https://rocky.example.com" }, home);
    expect(a.enabled && a.config.webhookUrl?.href).toBe(
      "https://rocky.example.com/webhooks/github",
    );
    const b = githubAppSetupFromEnv({ ...ON, GITHUB_APP_WEBHOOK_URL: "https://smee.io/abc" }, home);
    expect(b.enabled && b.config.webhookUrl?.href).toBe("https://smee.io/abc");
  });

  it("takes an https GITHUB_APP_HOMEPAGE_URL (review round 1, item 11)", () => {
    const setup = githubAppSetupFromEnv(
      { ...ON, GITHUB_APP_HOMEPAGE_URL: "https://github.com/rocky-reviews/rocky" },
      home,
    );
    expect(setup.enabled && setup.config.homepageUrl?.href).toBe(
      "https://github.com/rocky-reviews/rocky",
    );
    expect(() =>
      githubAppSetupFromEnv({ ...ON, GITHUB_APP_HOMEPAGE_URL: "http://example.com" }, home),
    ).toThrow(ConfigError);
  });

  it("refuses setup on Windows, where file modes cannot protect the credentials (item 7)", () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...original, value: "win32" });
    try {
      expect(() => githubAppSetupFromEnv(ON, home)).toThrow(/Windows/);
      // Not requested → no error, whatever the platform.
      expect(githubAppSetupFromEnv({}, home)).toStrictEqual({
        enabled: false,
        reason: "not_requested",
      });
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it("fails closed on unsafe URLs, names and paths", () => {
    for (const env of [
      { ROCKY_PUBLIC_URL: "http://rocky.example.com" },
      { ROCKY_PUBLIC_URL: "https://rocky.example.com/base" },
      { ROCKY_PUBLIC_URL: "https://u:p@rocky.example.com" },
      { ROCKY_PUBLIC_URL: "https://rocky.example.com/?a=1" },
      { HOST: "0.0.0.0" },
      { GITHUB_APP_WEBHOOK_URL: "http://smee.io/abc" },
      { GITHUB_APP_WEBHOOK_URL: "https://u:p@smee.io/abc" },
      { GITHUB_URL: "http://ghe.example" },
      { GITHUB_API_URL: "https://evil.example/path" },
      { GITHUB_APP_NAME: "<script>" },
      { GITHUB_APP_CREDENTIALS_FILE: "relative.env" },
    ]) {
      expect(() => githubAppSetupFromEnv({ ...ON, ...env }, home), JSON.stringify(env)).toThrow(
        ConfigError,
      );
    }
  });
});
