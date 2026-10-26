import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/**
 * GitHub App authentication as the app itself (P3-3): an RS256 JSON Web Token signed with the
 * app's private key, as GitHub documents for `GET /app/...` endpoints. Built with `node:crypto`
 * only (no JWT library): one fixed header, three claims, one signature.
 *
 * Neither the key nor a token ever leaves this module except as the `Authorization` header of a
 * request to the configured GitHub API. Errors carry fixed messages that name the variable,
 * never its value.
 */

export class GitHubAppConfigError extends Error {
  override readonly name = "GitHubAppConfigError";
}

/** Parsed, validated app credentials. The key is a `KeyObject`; the PEM text is not kept. */
export interface GitHubAppAuth {
  readonly appId: number;
  readonly privateKey: KeyObject;
}

const APP_ID = /^[1-9][0-9]{0,15}$/;
/** A PEM private key is ~1.7 KB for RSA-2048; anything far larger is not one. */
const MAX_PEM_LENGTH = 16 * 1024;
export const MIN_RSA_BITS = 2048;

/**
 * Validates `GITHUB_APP_ID` (a positive integer) and `GITHUB_APP_PRIVATE_KEY` (a PEM RSA private
 * key of at least 2048 bits, unencrypted). Secret managers that cannot hold newlines often store
 * the PEM with literal `\n`; that form is accepted too.
 */
export const parseGitHubAppAuth = (raw: { appId: string; privateKey: string }): GitHubAppAuth => {
  if (typeof raw.appId !== "string" || !APP_ID.test(raw.appId)) {
    throw new GitHubAppConfigError("GITHUB_APP_ID must be a positive integer");
  }
  const appId = Number(raw.appId);
  if (!Number.isSafeInteger(appId)) {
    throw new GitHubAppConfigError("GITHUB_APP_ID must be a positive integer");
  }
  if (typeof raw.privateKey !== "string" || raw.privateKey.length > MAX_PEM_LENGTH) {
    throw new GitHubAppConfigError("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  }
  const pem =
    raw.privateKey.includes("\n") || !raw.privateKey.includes("\\n")
      ? raw.privateKey
      : raw.privateKey.replaceAll("\\n", "\n");
  if (!/^\s*-----BEGIN (?:RSA )?PRIVATE KEY-----\r?\n/.test(pem)) {
    throw new GitHubAppConfigError("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw new GitHubAppConfigError("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  }
  if (
    privateKey.asymmetricKeyType !== "rsa" ||
    (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS
  ) {
    throw new GitHubAppConfigError(
      `GITHUB_APP_PRIVATE_KEY must be an RSA key of at least ${MIN_RSA_BITS} bits`,
    );
  }
  return Object.freeze({ appId, privateKey });
};

const base64url = (value: string | Buffer): string =>
  (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");

/** GitHub refuses an app JWT whose expiry is more than 10 minutes ahead. */
export const APP_JWT_LIFETIME_SECONDS = 540;
/** Issued slightly in the past, as GitHub recommends, to absorb clock drift. */
export const APP_JWT_BACKDATE_SECONDS = 60;

/**
 * An RS256 app JWT: `{"alg":"RS256","typ":"JWT"}` / `{ iat, exp, iss }`, signed with
 * RSASSA-PKCS1-v1_5 SHA-256. Valid from `now - 60 s` to `now + 9 min`.
 */
export const githubAppJwt = (auth: GitHubAppAuth, now: Date): string => {
  const seconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(seconds)) throw new GitHubAppConfigError("invalid clock");
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: seconds - APP_JWT_BACKDATE_SECONDS,
      exp: seconds + APP_JWT_LIFETIME_SECONDS,
      iss: String(auth.appId),
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput, "ascii"), auth.privateKey);
  return `${signingInput}.${base64url(signature)}`;
};
