import { checkWebhookSecret } from "@rocky-reviews/forge-github";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * `GITHUB_WEBHOOK_SECRET` (P3-2). Required in production (`NODE_ENV=production`): the server
 * refuses to boot without it. Elsewhere an unset secret disables the receiver (no route, 404)
 * rather than verifying against an empty key. A secret that is set but too short or padded is
 * refused everywhere. Messages never contain the value.
 */
export const webhookSecretFromEnv = (env: Readonly<Record<string, string | undefined>>) => {
  const secret = env["GITHUB_WEBHOOK_SECRET"];
  if (secret === undefined || secret === "") {
    if (env["NODE_ENV"] === "production") {
      throw new ConfigError("GITHUB_WEBHOOK_SECRET is required when NODE_ENV=production");
    }
    return undefined;
  }
  try {
    return checkWebhookSecret(secret);
  } catch (error) {
    throw new ConfigError(`GITHUB_WEBHOOK_SECRET: ${(error as Error).message}`);
  }
};
