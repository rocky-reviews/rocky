import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.js";
import {
  addressKey,
  clientAddress,
  describeTrustProxy,
  resolveClientAddress,
  trustProxyFromEnv,
} from "./client-ip.js";

/** P7-3 (ADR 0025): which address a rate limit counts, and when forwarded headers are believed. */

const req = (
  remoteAddress: string | undefined,
  headers: Record<string, string | string[]> = {},
) => ({
  headers,
  socket: { remoteAddress },
});

describe("clientAddress", () => {
  it("none: forwarded headers are ignored entirely (not behind a proxy)", () => {
    const r = req("203.0.113.9", {
      "x-forwarded-for": "198.51.100.1",
      "fly-client-ip": "198.51.100.2",
    });
    expect(clientAddress(r, { kind: "none" })).toBe("203.0.113.9");
  });

  it("fly: Fly-Client-IP, which Fly's proxy sets; X-Forwarded-For is ignored", () => {
    const r = req("172.16.0.2", {
      "fly-client-ip": "198.51.100.2",
      "x-forwarded-for": "192.0.2.1",
    });
    expect(clientAddress(r, { kind: "fly" })).toBe("198.51.100.2");
  });

  it("fly: a missing, repeated or malformed header falls back to the socket (the proxy's bucket)", () => {
    for (const headers of [
      {},
      { "fly-client-ip": "" },
      { "fly-client-ip": "not-an-ip" },
      { "fly-client-ip": "198.51.100.2, 192.0.2.1" },
      { "fly-client-ip": ["198.51.100.2", "192.0.2.1"] },
    ]) {
      expect(clientAddress(req("172.16.0.2", headers), { kind: "fly" })).toBe("172.16.0.2");
    }
  });

  it("xff: the address the outermost trusted proxy saw, counted from the right", () => {
    // Client spoofs two entries; Cloudflare appends the real client; Fly appends Cloudflare.
    const headers = { "x-forwarded-for": "6.6.6.6, 7.7.7.7, 198.51.100.7, 104.16.0.1" };
    expect(clientAddress(req("172.16.0.2", headers), { kind: "xff", hops: 2 })).toBe(
      "198.51.100.7",
    );
    expect(clientAddress(req("172.16.0.2", headers), { kind: "xff", hops: 1 })).toBe("104.16.0.1");
  });

  it("xff: fewer entries than hops, or a malformed chosen entry, falls back to the socket", () => {
    const one = { "x-forwarded-for": "198.51.100.7" };
    expect(clientAddress(req("172.16.0.2", one), { kind: "xff", hops: 2 })).toBe("172.16.0.2");
    const bad = { "x-forwarded-for": "198.51.100.7, evil, 104.16.0.1" };
    expect(clientAddress(req("172.16.0.2", bad), { kind: "xff", hops: 2 })).toBe("172.16.0.2");
    expect(clientAddress(req("172.16.0.2", {}), { kind: "xff", hops: 1 })).toBe("172.16.0.2");
  });

  it("says when a trusted mode fell back to the peer, and why (for the limiter's warning)", () => {
    const peer = "172.16.0.2";
    expect(resolveClientAddress(req(peer, {}), { kind: "fly" })).toEqual({
      address: peer,
      fallback: "missing",
    });
    expect(resolveClientAddress(req(peer, { "fly-client-ip": "nope" }), { kind: "fly" })).toEqual({
      address: peer,
      fallback: "malformed",
    });
    expect(
      resolveClientAddress(req(peer, { "fly-client-ip": ["198.51.100.2", "192.0.2.1"] }), {
        kind: "fly",
      }),
    ).toEqual({ address: peer, fallback: "malformed" });
    expect(resolveClientAddress(req(peer, {}), { kind: "xff", hops: 1 })).toEqual({
      address: peer,
      fallback: "missing",
    });
    expect(
      resolveClientAddress(req(peer, { "x-forwarded-for": "198.51.100.7" }), {
        kind: "xff",
        hops: 2,
      }),
    ).toEqual({ address: peer, fallback: "missing" });
    expect(
      resolveClientAddress(req(peer, { "x-forwarded-for": "evil" }), { kind: "xff", hops: 1 }),
    ).toEqual({ address: peer, fallback: "malformed" });
    expect(
      resolveClientAddress(req(peer, { "fly-client-ip": "198.51.100.2" }), { kind: "fly" }),
    ).toEqual({ address: "198.51.100.2" });
    expect(resolveClientAddress(req(peer, {}), { kind: "none" })).toEqual({ address: peer });
  });

  it("an unknown socket address is one shared bucket, never an exemption", () => {
    expect(clientAddress(req(undefined), { kind: "none" })).toBe("unknown");
  });
});

describe("addressKey", () => {
  it("IPv4 stays as is; IPv4-mapped IPv6 is the IPv4 address", () => {
    expect(addressKey("198.51.100.7")).toBe("198.51.100.7");
    expect(addressKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(addressKey("::FFFF:198.51.100.7")).toBe("198.51.100.7");
  });

  it("IPv6 counts per /64, however it is written, so rotating within a /64 does not help", () => {
    const keys = [
      "2001:db8:1:2::1",
      "2001:db8:1:2:ffff:ffff:ffff:ffff",
      "2001:0DB8:0001:0002:0:0:0:9",
      "2001:db8:1:2::1%eth0",
      "[2001:db8:1:2::5]",
    ].map(addressKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:3::1")).not.toBe(keys[0]);
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
  });

  it("anything else is one shared bucket", () => {
    expect(addressKey("garbage")).toBe("unknown");
    expect(addressKey("")).toBe("unknown");
  });
});

describe("trustProxyFromEnv", () => {
  it("defaults to none outside production", () => {
    expect(trustProxyFromEnv({})).toEqual({ kind: "none" });
  });

  it("production must choose explicitly (a wrong default either trusts spoofable headers or rate-limits everyone as one)", () => {
    expect(() => trustProxyFromEnv({ NODE_ENV: "production" })).toThrow(ConfigError);
    expect(trustProxyFromEnv({ NODE_ENV: "production", ROCKY_TRUST_PROXY: "none" })).toEqual({
      kind: "none",
    });
  });

  it("none is refused on Fly.io: every client would share the proxy's one bucket", () => {
    expect(() => trustProxyFromEnv({ ROCKY_TRUST_PROXY: "none", FLY_APP_NAME: "rocky" })).toThrow(
      /refused on Fly.io/,
    );
    expect(() => trustProxyFromEnv({ ROCKY_TRUST_PROXY: "none", FLY_APP_NAME: "rocky" })).toThrow(
      ConfigError,
    );
    expect(trustProxyFromEnv({ ROCKY_TRUST_PROXY: "xff:1", FLY_APP_NAME: "rocky" })).toEqual({
      kind: "xff",
      hops: 1,
    });
  });

  it("describes the mode for the boot log (no addresses)", () => {
    expect(describeTrustProxy({ kind: "none" })).toBe("none");
    expect(describeTrustProxy({ kind: "fly" })).toBe("fly");
    expect(describeTrustProxy({ kind: "xff", hops: 2 })).toBe("xff:2");
  });

  it("fly only on Fly.io: elsewhere anyone could send Fly-Client-IP", () => {
    expect(() => trustProxyFromEnv({ ROCKY_TRUST_PROXY: "fly" })).toThrow(ConfigError);
    expect(trustProxyFromEnv({ ROCKY_TRUST_PROXY: "fly", FLY_APP_NAME: "rocky" })).toEqual({
      kind: "fly",
    });
  });

  it("xff:<hops> with 1 to 5 hops; anything else is refused", () => {
    expect(trustProxyFromEnv({ ROCKY_TRUST_PROXY: "xff:2" })).toEqual({ kind: "xff", hops: 2 });
    for (const bad of ["xff", "xff:0", "xff:6", "xff:-1", "xff:1.5", "XFF:1", "true", "all", " "]) {
      expect(() => trustProxyFromEnv({ ROCKY_TRUST_PROXY: bad }), bad).toThrow(ConfigError);
    }
  });
});
