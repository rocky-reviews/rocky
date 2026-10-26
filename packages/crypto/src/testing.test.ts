import { describe, expect, it } from "vitest";
import { assertNoPlaintextLeaks, findPlaintextLeaks } from "./testing.js";

const secret = "ghp_" + "Q".repeat(36);
const other = "sk-ant-" + "r".repeat(40);

describe("findPlaintextLeaks", () => {
  it("returns nothing for a dump that only holds ciphertext", () => {
    const dump = "COPY tokens (id, token) FROM stdin;\n1\trk1:AAAABBBBCCCC\n\\.\n";
    expect(findPlaintextLeaks(dump, [secret, other])).toEqual([]);
  });

  it("finds a secret stored as plain text", () => {
    expect(findPlaintextLeaks(`1\t${secret}\n`, [secret, other])).toEqual([
      { index: 0, encoding: "utf8" },
    ]);
  });

  it("finds a secret stored as pg_dump hex bytea", () => {
    const dump = `1\t\\x${Buffer.from(other).toString("hex")}\n`;
    expect(findPlaintextLeaks(dump, [secret, other])).toEqual([{ index: 1, encoding: "hex" }]);
  });

  it("finds base64 and base64url encodings", () => {
    // Bytes whose base64 uses `+` and `/`, so the two alphabets are distinguishable.
    const urlOnly = "ghs_" + "?>".repeat(18);
    const b64 = Buffer.from(secret).toString("base64");
    const url = Buffer.from(urlOnly).toString("base64url");
    expect(findPlaintextLeaks(`${b64}\n${url}`, [secret, urlOnly])).toEqual([
      { index: 0, encoding: "base64" },
      { index: 1, encoding: "base64url" },
    ]);
  });

  it("finds a secret embedded at any alignment inside a larger base64 blob", () => {
    for (const prefix of ["", "a", "ab", "abc"]) {
      const blob = Buffer.from(`${prefix}${secret}trailing`).toString("base64");
      expect(findPlaintextLeaks(blob, [secret])).toEqual([{ index: 0, encoding: "base64" }]);
    }
  });

  it("accepts a binary dump", () => {
    expect(findPlaintextLeaks(Buffer.from(`x ${secret} y`), [secret])).toEqual([
      { index: 0, encoding: "utf8" },
    ]);
  });

  it("ignores empty secrets instead of matching everything", () => {
    expect(findPlaintextLeaks("anything", [""])).toEqual([]);
  });
});

describe("assertNoPlaintextLeaks", () => {
  it("passes on a clean dump", () => {
    expect(() => assertNoPlaintextLeaks("rk1:abc", [secret])).not.toThrow();
  });

  it("throws naming the leaked secret by index, never by value", () => {
    let caught: Error | undefined;
    try {
      assertNoPlaintextLeaks(`a ${secret} b`, ["unused", secret]);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain("#1 (utf8)");
    expect(caught?.message).not.toContain(secret);
  });
});
