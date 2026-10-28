import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  csrfTokenFor,
  decodeLoginCookie,
  encodeLoginCookie,
  randomToken,
  readCookie,
  serializeCookie,
} from "./cookies.js";
import { csrfRefusal } from "./csrf.js";

/** P7-1 (ADR 0020 §3, §5): the CSRF decision and the cookie primitives, without a database. */

const secret = randomBytes(32);
const policy = { origin: "https://rocky.example.com", secret, cookieSecure: true };
const token = randomToken();
const good = {
  cookie: `__Host-rocky_session=${token}`,
  origin: policy.origin,
  "sec-fetch-site": "same-origin",
  "x-rocky-csrf": csrfTokenFor(secret, token),
};

describe("csrfRefusal", () => {
  it("lets safe methods through and refuses state changes without every check", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(csrfRefusal({ method, headers: {} }, policy)).toBeUndefined();
    }
    expect(csrfRefusal({ method: "POST", headers: good }, policy)).toBeUndefined();
    const cases: [Record<string, string | undefined>, string][] = [
      [{ "sec-fetch-site": "cross-site" }, "cross_site"],
      [{ "sec-fetch-site": "same-site" }, "cross_site"],
      [{ "sec-fetch-site": "none" }, "cross_site"],
      [{ origin: "https://evil.com" }, "origin"],
      [{ origin: "https://rocky.example.com.evil.com" }, "origin"],
      [{ origin: "http://rocky.example.com" }, "origin"],
      [{ origin: "null" }, "origin"],
      [{ origin: undefined }, "no_origin"],
      [{ origin: undefined, referer: "https://evil.com/x" }, "origin"],
      [{ origin: undefined, referer: "not a url" }, "origin"],
      [{ "x-rocky-csrf": undefined }, "token"],
      [{ "x-rocky-csrf": csrfTokenFor(randomBytes(32), token) }, "token"],
      [{ "x-rocky-csrf": csrfTokenFor(secret, randomToken()) }, "token"],
      [{ cookie: undefined }, "token"],
      [{ cookie: `rocky_session=${token}` }, "token"],
    ];
    for (const [change, reason] of cases) {
      const headers = Object.fromEntries(
        Object.entries({ ...good, ...change }).filter(([, v]) => v !== undefined),
      ) as Record<string, string>;
      expect(csrfRefusal({ method: "POST", headers }, policy), JSON.stringify(change)).toBe(reason);
    }
    expect(csrfRefusal({ method: "DELETE", headers: good }, undefined)).toBe("not_configured");
    const viaReferer = Object.fromEntries(
      Object.entries({ ...good, referer: "https://rocky.example.com/inbox" }).filter(
        ([k]) => k !== "origin",
      ),
    );
    expect(csrfRefusal({ method: "PATCH", headers: viaReferer }, policy)).toBeUndefined();
  });
});

describe("cookies", () => {
  it("reads exactly one cookie by name; duplicates and oversized headers count as none", () => {
    expect(readCookie("a=1; rocky_session=x; b=2", "rocky_session")).toBe("x");
    expect(readCookie("rocky_session=x; rocky_session=y", "rocky_session")).toBeUndefined();
    expect(readCookie("xrocky_session=x", "rocky_session")).toBeUndefined();
    expect(readCookie(`rocky_session=${"x".repeat(9000)}`, "rocky_session")).toBeUndefined();
    expect(readCookie(undefined, "rocky_session")).toBeUndefined();
    expect(readCookie(" \t rocky_session=x \t", "rocky_session")).toBe("x");
  });

  it("only space and tab are trimmed: a look-alike name with other whitespace is not the cookie", () => {
    for (const name of ["__Host-rocky_login", "__Host-rocky_session"]) {
      for (const pad of ["\u00a0", "\u2028", "\ufeff", "\u000b", "\f", "\u3000"]) {
        expect(readCookie(`${pad}${name}=forged`, name), JSON.stringify(pad)).toBeUndefined();
        expect(readCookie(`${name}${pad}=forged`, name), JSON.stringify(pad)).toBeUndefined();
        // And it does not count as a duplicate of the real one either.
        expect(readCookie(`${pad}${name}=forged; ${name}=real`, name)).toBe("real");
      }
    }
    // Names that are not RFC 6265 tokens are ignored.
    expect(readCookie("rocky session=x", "rocky session")).toBeUndefined();
    expect(readCookie("=x", "")).toBeUndefined();
  });

  it("serializes host-only, HttpOnly, SameSite=Lax cookies; Secure and __Host- unless the dev exception", () => {
    expect(serializeCookie("rocky_session", "v", { secure: true, maxAgeSeconds: 60 })).toBe(
      "__Host-rocky_session=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure",
    );
    expect(serializeCookie("rocky_session", "v", { secure: false, maxAgeSeconds: 60 })).toBe(
      "rocky_session=v; Path=/; Max-Age=60; HttpOnly; SameSite=Lax",
    );
  });

  it("the login cookie verifies only with the secret, unchanged and unexpired", () => {
    const binding = { state: randomToken(), verifier: randomToken(), expiresAt: 2_000_000_000 };
    const value = encodeLoginCookie(secret, binding);
    expect(decodeLoginCookie(secret, value, 1_999_999_999_000)).toEqual(binding);
    expect(decodeLoginCookie(secret, value, 2_000_000_000_000)).toBeUndefined();
    expect(decodeLoginCookie(randomBytes(32), value, 0)).toBeUndefined();
    const tampered = value.replace(binding.state, randomToken());
    expect(decodeLoginCookie(secret, tampered, 0)).toBeUndefined();
    expect(decodeLoginCookie(secret, undefined, 0)).toBeUndefined();
    expect(decodeLoginCookie(secret, "v1.a.b.c.d", 0)).toBeUndefined();
  });
});
