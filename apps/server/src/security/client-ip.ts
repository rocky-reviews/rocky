import { isIP, isIPv4 } from "node:net";
import { ConfigError, isProduction } from "../config.js";

/**
 * Which client address a rate limit counts (P7-3, ADR 0025). Forwarded headers are believed only
 * when the operator says a proxy sets them (`ROCKY_TRUST_PROXY`); otherwise any client could
 * send `X-Forwarded-For: <random>` and get a fresh bucket on every request.
 *
 *   none       the socket's peer (no proxy, or a proxy that is not trusted)
 *   fly        `Fly-Client-IP`, which Fly.io's proxy sets (only accepted on Fly.io)
 *   xff:<n>    the n-th `X-Forwarded-For` entry from the right: each of n trusted proxies
 *              appends the address it saw, so entries left of that are client-controlled
 *              (Cloudflare in front of Fly: xff:2)
 *
 * Anything missing or malformed falls back to the socket's peer: the proxy's own address, one
 * shared bucket, never an exemption.
 */

export type TrustProxy =
  | { readonly kind: "none" }
  | { readonly kind: "fly" }
  | { readonly kind: "xff"; readonly hops: number };

type Env = Readonly<Record<string, string | undefined>>;

export const MAX_PROXY_HOPS = 5;

export const trustProxyFromEnv = (env: Env): TrustProxy => {
  const raw = env["ROCKY_TRUST_PROXY"];
  if (raw === undefined || raw === "") {
    if (isProduction(env)) {
      throw new ConfigError(
        "ROCKY_TRUST_PROXY is required in production: none, fly (on Fly.io) or xff:<hops> (rate limits count per client address)",
      );
    }
    return { kind: "none" };
  }
  if (raw === "none") return { kind: "none" };
  if (raw === "fly") {
    if ((env["FLY_APP_NAME"] ?? "") === "") {
      throw new ConfigError(
        "ROCKY_TRUST_PROXY=fly is only accepted on Fly.io (FLY_APP_NAME set): elsewhere any client can send Fly-Client-IP",
      );
    }
    return { kind: "fly" };
  }
  const match = /^xff:([1-9])$/.exec(raw);
  const hops = match === null ? NaN : Number(match[1]);
  if (!(hops >= 1 && hops <= MAX_PROXY_HOPS)) {
    throw new ConfigError(
      `ROCKY_TRUST_PROXY must be none, fly or xff:<hops> with 1 to ${MAX_PROXY_HOPS} hops`,
    );
  }
  return { kind: "xff", hops };
};

interface RequestLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly socket: { readonly remoteAddress?: string | undefined };
}

const UNKNOWN = "unknown";

const plainAddress = (value: string): string | undefined => {
  const bare = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const unzoned = bare.split("%", 1)[0] ?? "";
  return isIP(unzoned) === 0 ? undefined : unzoned;
};

export const clientAddress = (request: RequestLike, trust: TrustProxy): string => {
  const peer = request.socket.remoteAddress ?? UNKNOWN;
  if (trust.kind === "none") return peer;
  if (trust.kind === "fly") {
    const value = request.headers["fly-client-ip"];
    return (typeof value === "string" ? plainAddress(value.trim()) : undefined) ?? peer;
  }
  // Node joins repeated X-Forwarded-For headers with ", ", which is what a proxy chain means.
  const value = request.headers["x-forwarded-for"];
  const raw = Array.isArray(value) ? value.join(",") : value;
  if (raw === undefined) return peer;
  const entries = raw.split(",").map((e) => e.trim());
  if (entries.length < trust.hops) return peer;
  return plainAddress(entries[entries.length - trust.hops] ?? "") ?? peer;
};

/** Eight 16-bit groups of an IPv6 address, or undefined. */
const ipv6Groups = (address: string): number[] | undefined => {
  let text = address.toLowerCase();
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4 !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = (v4[2] ?? "").split(".").map(Number);
    text = `${v4[1] ?? ""}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const numbers = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return numbers.some(Number.isNaN) ? undefined : numbers;
};

/**
 * The rate-limit key of an address: IPv4 as is, IPv6 per /64 (one customer usually gets a whole
 * /64, so counting single addresses would let them rotate freely). IPv4-mapped IPv6 is IPv4.
 */
export const addressKey = (address: string): string => {
  const plain = plainAddress(address);
  if (plain === undefined) return UNKNOWN;
  if (isIPv4(plain)) return plain;
  const groups = ipv6Groups(plain);
  if (groups === undefined) return UNKNOWN;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi = 0, lo = 0] = groups.slice(6);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
};
