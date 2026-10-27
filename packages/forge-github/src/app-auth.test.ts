import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APP_JWT_LIFETIME_SECONDS,
  GitHubAppConfigError,
  githubAppJwt,
  parseGitHubAppAuth,
} from "./app-auth.js";
import { rsaPrivateKeyPem, testAppKeys } from "./testing.js";

/** P3-3: app credentials are validated at boot and the app JWT is built with node:crypto only. */

const keys = testAppKeys();
const NOW = new Date("2026-10-26T12:00:00Z");

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

describe("parseGitHubAppAuth", () => {
  it("accepts a positive app id and an RSA-2048 PEM (multi-line or with literal \\n)", () => {
    const auth = parseGitHubAppAuth({ appId: "123456", privateKey: keys.privateKeyPem });
    expect(auth.appId).toBe(123456);
    expect(auth.privateKey.asymmetricKeyType).toBe("rsa");
    const escaped = keys.privateKeyPem.trimEnd().replaceAll("\n", "\\n");
    expect(parseGitHubAppAuth({ appId: "1", privateKey: escaped }).appId).toBe(1);
    expect(Object.isFrozen(auth)).toBe(true);
  });

  it("refuses bad app ids", () => {
    for (const appId of ["", "0", "-1", "1.5", "12a", " 12", "99999999999999999", "0x10"]) {
      expect(() => parseGitHubAppAuth({ appId, privateKey: keys.privateKeyPem }), appId).toThrow(
        GitHubAppConfigError,
      );
    }
  });

  it("refuses keys that are not an unencrypted RSA key of at least 2048 bits, naming no value", () => {
    const small = rsaPrivateKeyPem(1024);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const encrypted = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "test-only-passphrase",
      })
      .toString();
    const publicOnly = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const truncated = keys.privateKeyPem.slice(0, 200);
    for (const [label, privateKey] of Object.entries({
      small,
      ec,
      encrypted,
      publicOnly,
      truncated,
      empty: "",
      garbage: "not a key",
      huge: `-----BEGIN RSA PRIVATE KEY-----\n${"A".repeat(20_000)}`,
    })) {
      let caught: unknown;
      try {
        parseGitHubAppAuth({ appId: "1", privateKey });
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(GitHubAppConfigError);
      const message = (caught as Error).message;
      expect(message, label).toMatch(/^GITHUB_APP_PRIVATE_KEY/);
      expect(message, label).not.toContain("BEGIN");
      expect(message, label).not.toContain(keys.privateKeyPem.slice(40, 80));
    }
  });
});

describe("githubAppJwt", () => {
  const auth = parseGitHubAppAuth({ appId: "123456", privateKey: keys.privateKeyPem });

  it("is an RS256 JWT for the app, issued 60 s in the past, valid for 9 minutes", () => {
    const token = githubAppJwt(auth, NOW);
    const [header, payload, signature] = token.split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const seconds = NOW.getTime() / 1000;
    expect(decode(payload)).toEqual({
      iat: seconds - 60,
      exp: seconds + APP_JWT_LIFETIME_SECONDS,
      iss: "123456",
    });
    // GitHub's limit: no more than 10 minutes into the future.
    expect(APP_JWT_LIFETIME_SECONDS).toBeLessThanOrEqual(600);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        keys.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });

  it("does not verify under another key, and changes with the clock", () => {
    const other = testAppKeys();
    const [header, payload, signature] = githubAppJwt(auth, NOW).split(".") as [
      string,
      string,
      string,
    ];
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        other.publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(false);
    expect(githubAppJwt(auth, new Date(NOW.getTime() + 1000))).not.toBe(githubAppJwt(auth, NOW));
  });
});
