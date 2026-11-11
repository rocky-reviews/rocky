import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOneTimeLink, MAX_TOKEN_FAILURES, MAX_TRACKED_CLIENTS } from "./one-time-link.js";

/** The boot link shared by the setup wizard and token mode's sign-in (P10-4, ADR 0045 §3). */

const token = () => randomBytes(32).toString("base64url");

describe("createOneTimeLink", () => {
  it("redeems its own token once; never again, not even for the same client", () => {
    const value = token();
    const link = createOneTimeLink(value);
    expect(link.used).toBe(false);
    expect(link.redeem(value, "a")).toBe("redeemed");
    expect(link.used).toBe(true);
    expect(link.redeem(value, "a")).toBe("bad_token");
    expect(link.redeem(value, "b")).toBe("bad_token");
  });

  it("a released redemption is usable again (its sign-in could not complete); burn is final", () => {
    const value = token();
    const link = createOneTimeLink(value);
    expect(link.redeem(value, "a")).toBe("redeemed");
    // While a redemption is pending, nobody else gets in with it.
    expect(link.redeem(value, "b")).toBe("bad_token");
    link.release();
    expect(link.used).toBe(false);
    expect(link.redeem(value, "a")).toBe("redeemed");
    link.burn();
    link.release();
    expect(link.used).toBe(true);
    expect(link.redeem(value, "a")).toBe("bad_token");
  });

  it("refuses another token, and nothing at all without counting it", () => {
    const value = token();
    const link = createOneTimeLink(value);
    for (let i = 0; i < MAX_TOKEN_FAILURES * 2; i++)
      expect(link.redeem(null, "a")).toBe("bad_token");
    expect(link.redeem(token(), "a")).toBe("bad_token");
    expect(link.redeem(value, "a")).toBe("redeemed");
  });

  it("locks out one client address after repeated wrong tokens, never the others", () => {
    const value = token();
    const link = createOneTimeLink(value);
    for (let i = 0; i < MAX_TOKEN_FAILURES; i++) link.redeem(token(), "attacker");
    expect(link.redeem(value, "attacker")).toBe("token_locked");
    expect(link.redeem(value, "operator")).toBe("redeemed");
  });

  it("remembers a bounded number of addresses, forgetting the oldest", () => {
    const link = createOneTimeLink(token());
    for (let i = 0; i < MAX_TOKEN_FAILURES; i++) link.redeem(token(), "first");
    expect(link.redeem(token(), "first")).toBe("token_locked");
    for (let i = 0; i < MAX_TRACKED_CLIENTS; i++) link.redeem(token(), `client-${i}`);
    expect(link.redeem(token(), "first")).toBe("bad_token");
  });

  it("burn refuses every later redemption", () => {
    const value = token();
    const link = createOneTimeLink(value);
    link.burn();
    expect(link.redeem(value, "a")).toBe("bad_token");
  });
});
