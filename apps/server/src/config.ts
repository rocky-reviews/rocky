import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  buildGitHubAppManifest,
  checkWebhookSecret,
  githubEndpoints,
} from "@rocky-reviews/forge-github";
import type { GitHubAppSetupConfig } from "./github-app-setup.js";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Production for the purposes of required secrets: `NODE_ENV=production`, or running on Fly.io
 * (`FLY_APP_NAME` is set by the platform), so a deployment that forgets NODE_ENV still fails
 * closed instead of silently starting without webhooks.
 */
export const isProduction = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env["NODE_ENV"] === "production" || (env["FLY_APP_NAME"] ?? "") !== "";

/**
 * `GITHUB_WEBHOOK_SECRET` (P3-2). Required in production (see `isProduction`): the server
 * refuses to boot without it. Elsewhere an unset secret disables the receiver (no route, 404)
 * rather than verifying against an empty key. A secret that is set but too short or padded is
 * refused everywhere. Messages never contain the value.
 */
export const webhookSecretFromEnv = (env: Readonly<Record<string, string | undefined>>) => {
  const secret = env["GITHUB_WEBHOOK_SECRET"];
  if (secret === undefined || secret === "") {
    if (isProduction(env)) {
      throw new ConfigError(
        "GITHUB_WEBHOOK_SECRET is required in production (NODE_ENV=production or FLY_APP_NAME set)",
      );
    }
    return undefined;
  }
  try {
    return checkWebhookSecret(secret);
  } catch (error) {
    throw new ConfigError(`GITHUB_WEBHOOK_SECRET: ${(error as Error).message}`);
  }
};

type Env = Readonly<Record<string, string | undefined>>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const urlFrom = (raw: string, name: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a URL`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ConfigError(`${name} must not carry credentials, a query or a fragment`);
  }
  if (raw.includes("?") || raw.includes("#")) {
    throw new ConfigError(`${name} must not carry credentials, a query or a fragment`);
  }
  return url;
};

const nonEmpty = (env: Env, name: string): string | undefined => {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
};

export type GitHubAppSetup =
  | { enabled: false; reason: "not_requested" | "configured" }
  | { enabled: true; config: GitHubAppSetupConfig };

/**
 * GitHub App manifest setup (P3-1, ADR 0008). Off unless `GITHUB_APP_SETUP=true`; refused in
 * production (a ConfigError, so the server does not boot); off once an app is configured
 * (`GITHUB_APP_ID` set, or the credentials file exists). Every URL is validated here, so the
 * routes only ever see https endpoints and a public URL that is https or http on loopback.
 */
export const githubAppSetupFromEnv = (env: Env, homedir: string): GitHubAppSetup => {
  if (env["GITHUB_APP_SETUP"] !== "true") return { enabled: false, reason: "not_requested" };
  if (isProduction(env)) {
    throw new ConfigError(
      "GITHUB_APP_SETUP is for creating the app from a workstation; it is refused in production",
    );
  }
  if (process.platform === "win32") {
    // The credentials file is protected by POSIX modes (0600/0700), which Windows does not apply.
    throw new ConfigError(
      "GITHUB_APP_SETUP is not supported on Windows (file modes cannot protect the credentials); run it under WSL, macOS or Linux",
    );
  }
  const credentialsFile =
    nonEmpty(env, "GITHUB_APP_CREDENTIALS_FILE") ?? join(homedir, ".rocky", "github-app.env");
  if (!isAbsolute(credentialsFile)) {
    throw new ConfigError("GITHUB_APP_CREDENTIALS_FILE must be an absolute path");
  }
  if (nonEmpty(env, "GITHUB_APP_ID") !== undefined || pathExists(credentialsFile)) {
    return { enabled: false, reason: "configured" };
  }

  const host = env["HOST"] ?? "0.0.0.0";
  const publicRaw =
    nonEmpty(env, "ROCKY_PUBLIC_URL") ??
    `http://${host.includes(":") ? `[${host}]` : host}:${env["PORT"] ?? "4310"}`;
  const publicUrl = urlFrom(publicRaw, "ROCKY_PUBLIC_URL");
  const loopbackHttp = publicUrl.protocol === "http:" && LOOPBACK.has(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !loopbackHttp) {
    throw new ConfigError(
      "ROCKY_PUBLIC_URL must be https, or http on 127.0.0.1/localhost (set it explicitly when HOST is 0.0.0.0)",
    );
  }
  if (publicUrl.pathname !== "/") throw new ConfigError("ROCKY_PUBLIC_URL must not have a path");

  const webhookRaw = nonEmpty(env, "GITHUB_APP_WEBHOOK_URL");
  let webhookUrl: URL | undefined;
  if (webhookRaw !== undefined) {
    webhookUrl = urlFrom(webhookRaw, "GITHUB_APP_WEBHOOK_URL");
    if (webhookUrl.protocol !== "https:")
      throw new ConfigError("GITHUB_APP_WEBHOOK_URL must be https");
  } else if (publicUrl.protocol === "https:") {
    webhookUrl = new URL("/webhooks/github", publicUrl);
  }

  const webUrl = nonEmpty(env, "GITHUB_URL");
  const apiUrl = nonEmpty(env, "GITHUB_API_URL");
  let endpoints;
  try {
    endpoints = githubEndpoints({
      ...(webUrl === undefined ? {} : { webUrl }),
      ...(apiUrl === undefined ? {} : { apiUrl }),
    });
  } catch (error) {
    throw new ConfigError(`GITHUB_URL/GITHUB_API_URL: ${(error as Error).message}`);
  }

  const homepageRaw = nonEmpty(env, "GITHUB_APP_HOMEPAGE_URL");
  let homepageUrl: URL | undefined;
  if (homepageRaw !== undefined) {
    homepageUrl = urlFrom(homepageRaw, "GITHUB_APP_HOMEPAGE_URL");
    if (homepageUrl.protocol !== "https:") {
      throw new ConfigError("GITHUB_APP_HOMEPAGE_URL must be https");
    }
  }

  const appName = nonEmpty(env, "GITHUB_APP_NAME") ?? "Rocky Reviews";
  try {
    // Validates the name (and the URLs once more) exactly as the page will use them.
    buildGitHubAppManifest({
      name: appName,
      publicUrl,
      webhookUrl: webhookUrl ?? new URL("https://example.invalid"),
    });
  } catch (error) {
    throw new ConfigError(`GITHUB_APP_NAME: ${(error as Error).message}`);
  }

  return {
    enabled: true,
    config: {
      publicUrl,
      webhookUrl,
      ...(homepageUrl === undefined ? {} : { homepageUrl }),
      appName,
      endpoints,
      credentialsFile,
    },
  };
};

/** Anything at the path (file, directory, even a dangling symlink) counts as configured. */
const pathExists = (path: string): boolean => {
  if (existsSync(path)) return true;
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
