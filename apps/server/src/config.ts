import { checkWebhookSecret } from "@rocky-reviews/forge-github";

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
