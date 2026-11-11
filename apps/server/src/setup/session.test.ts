import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  createSetupSessions,
  MAX_TOKEN_FAILURES,
  MAX_TRACKED_CLIENTS,
  SETUP_SESSION_TTL_MS,
  type SetupSessions,
} from "./session.js";

/** P10-2 (ADR 0044): the setup session shared by the manifest flow and the wizard. */

const token = randomBytes(32).toString("base64url");
const HTTP = new URL("http://127.0.0.1:4310");
const HTTPS = new URL("https://rocky.example.com");

const request = (headers: Record<string, string | undefined>): FastifyRequest =>
  ({ headers }) as unknown as FastifyRequest;

const valueOf = (cookie: string): string => cookie.split(";")[0]!.split("=")[1]!;

const started = (publicUrl = HTTP, now?: () => number) => {
  const sessions = createSetupSessions({ token, publicUrl, ...(now === undefined ? {} : { now }) });
  const redeemed = sessions.redeem(token);
  if (!redeemed.ok) throw new Error("redeem failed");
  return { sessions, cookie: redeemed.cookie, value: valueOf(redeemed.cookie) };
};

const post = (
  sessions: SetupSessions,
  name: string,
  value: string,
  extra: Record<string, string | undefined> = {},
) => {
  const base = request({ cookie: `${name}=${value}` });
  const csrf = sessions.csrfTokenOf(base);
  return request({
    cookie: `${name}=${value}`,
    origin: "http://127.0.0.1:4310",
    "sec-fetch-site": "same-origin",
    "x-rocky-csrf": csrf,
    ...extra,
  });
};

describe("setup sessions (P10-2)", () => {
  it("trades the token once for an HttpOnly, SameSite=Lax, Path=/ cookie that is not the token", () => {
    const { sessions, cookie, value } = started();
    expect(cookie).toMatch(
      /^rocky_setup=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=3600; HttpOnly; SameSite=Lax$/,
    );
    expect(cookie).not.toContain(token);
    expect(sessions.sessionOf(request({ cookie: `rocky_setup=${value}` }))).toBeDefined();
    expect(sessions.redeem(token)).toEqual({ ok: false, reason: "bad_token" });
  });

  it("uses the __Host- prefix and Secure on https", () => {
    const { sessions, cookie, value } = started(HTTPS);
    expect(cookie).toMatch(/^__Host-rocky_setup=/);
    expect(cookie).toContain("; Secure");
    // The unprefixed name is not read on https (no sibling subdomain can plant it).
    expect(sessions.sessionOf(request({ cookie: `rocky_setup=${value}` }))).toBeUndefined();
    expect(sessions.sessionOf(request({ cookie: `__Host-rocky_setup=${value}` }))).toBeDefined();
  });

  it("locks redemption for a client after too many wrong tokens from it", () => {
    const sessions = createSetupSessions({ token, publicUrl: HTTP });
    for (let i = 0; i < MAX_TOKEN_FAILURES; i++) {
      expect(sessions.redeem(randomBytes(32).toString("base64url"), "203.0.113.9").ok).toBe(false);
    }
    expect(sessions.redeem(token, "203.0.113.9")).toEqual({ ok: false, reason: "token_locked" });
    expect(sessions.redeem(null, "203.0.113.9")).toEqual({ ok: false, reason: "token_locked" });
  });

  it("does not lock out another client (fix round: no global lockout)", () => {
    const sessions = createSetupSessions({ token, publicUrl: HTTP });
    for (let i = 0; i < MAX_TOKEN_FAILURES * 2; i++) {
      sessions.redeem(randomBytes(32).toString("base64url"), "203.0.113.9");
    }
    expect(sessions.redeem(token, "198.51.100.7").ok).toBe(true);
  });

  it("does not count a missing or malformed token as a failure (crawlers)", () => {
    const sessions = createSetupSessions({ token, publicUrl: HTTP });
    for (let i = 0; i < MAX_TOKEN_FAILURES * 2; i++) {
      expect(sessions.redeem(null, "203.0.113.9")).toEqual({ ok: false, reason: "bad_token" });
    }
    expect(sessions.redeem(token, "203.0.113.9").ok).toBe(true);
  });

  it("bounds the clients it remembers (the oldest is forgotten first)", () => {
    const sessions = createSetupSessions({ token, publicUrl: HTTP });
    for (let i = 0; i < MAX_TOKEN_FAILURES; i++) {
      sessions.redeem(randomBytes(32).toString("base64url"), "203.0.113.9");
    }
    for (let i = 0; i < MAX_TRACKED_CLIENTS; i++) {
      sessions.redeem(randomBytes(32).toString("base64url"), `client-${i}`);
    }
    // The rate limit still bounds a forgotten client's tries; the token is 256-bit.
    expect(sessions.redeem(token, "203.0.113.9").ok).toBe(true);
  });

  it("expires sessions after an hour", () => {
    let t = 0;
    const { sessions, value } = started(HTTP, () => t);
    const req = request({ cookie: `rocky_setup=${value}` });
    expect(sessions.sessionOf(req)).toBeDefined();
    t = SETUP_SESSION_TTL_MS;
    expect(sessions.sessionOf(req)).toBeUndefined();
  });

  it("ignores malformed and unknown cookies", () => {
    const { sessions } = started();
    for (const cookie of [undefined, "rocky_setup=short", `rocky_setup=${"A".repeat(43)}`]) {
      expect(sessions.sessionOf(request({ cookie }))).toBeUndefined();
      expect(sessions.csrfTokenOf(request({ cookie }))).toBeUndefined();
    }
  });

  it("passes a same-origin POST with the session's synchronizer token", () => {
    const { sessions, value } = started();
    expect(sessions.checkCsrf(post(sessions, "rocky_setup", value))).toBeUndefined();
    // Referer stands in for a missing Origin.
    expect(
      sessions.checkCsrf(
        post(sessions, "rocky_setup", value, {
          origin: undefined,
          referer: "http://127.0.0.1:4310/setup",
        }),
      ),
    ).toBeUndefined();
  });

  it("refuses cross-site, foreign-origin, origin-less and token-less POSTs", () => {
    const { sessions, value } = started();
    const other = started();
    const cases: [Record<string, string | undefined>, string][] = [
      [{ "sec-fetch-site": "cross-site" }, "cross_site"],
      [{ "sec-fetch-site": "same-site" }, "cross_site"],
      [{ origin: "https://evil.example" }, "origin"],
      [{ origin: undefined, referer: "https://evil.example/x" }, "origin"],
      [{ origin: undefined }, "no_origin"],
      [{ "x-rocky-csrf": undefined }, "token"],
      [
        { "x-rocky-csrf": sessions.csrfTokenOf(request({ cookie: `rocky_setup=${other.value}` })) },
        "token",
      ],
      [{ cookie: undefined }, "token"],
    ];
    for (const [extra, reason] of cases) {
      expect(
        sessions.checkCsrf(post(sessions, "rocky_setup", value, extra)),
        JSON.stringify(extra),
      ).toBe(reason);
    }
  });

  it("close ends every session and refuses the token for good", () => {
    const { sessions, value } = started();
    sessions.close();
    expect(sessions.closed).toBe(true);
    expect(sessions.sessionOf(request({ cookie: `rocky_setup=${value}` }))).toBeUndefined();
    const fresh = createSetupSessions({ token, publicUrl: HTTP });
    fresh.close();
    expect(fresh.redeem(token).ok).toBe(false);
  });
});
