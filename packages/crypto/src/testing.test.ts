import { describe, expect, it } from "vitest";
import {
  assertNoKeyMaterial,
  assertNoPlaintextLeaks,
  expandDump,
  findKeyMaterial,
  findPlaintextLeaks,
} from "./testing.js";

const secret = "ghp_" + "Q".repeat(36);
const other = "sk-ant-" + "r".repeat(40);
const hexOf = (text: string): string => Buffer.from(text, "utf8").toString("hex");
/** A `rk1:` value whose payload is `header(4) || nonce(12) || tag(16) || body`. */
const fakeCiphertext = (body: Buffer | string): string =>
  "rk1:" + Buffer.concat([Buffer.alloc(32), Buffer.from(body)]).toString("base64url");

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

  describe("pg_dump escaping variants (review)", () => {
    const awkward = "a\tb\\c\nd'e\bf\fg\vh";

    it("COPY text: backslash, \\b, \\f, \\n, \\r, \\t and \\v are escaped", () => {
      const copy = "1\ta\\tb\\\\c\\nd'e\\bf\\fg\\vh\n";
      expect(findPlaintextLeaks(copy, [awkward])).toEqual([{ index: 0, encoding: "utf8" }]);
    });

    it("INSERT text: a single quote is doubled", () => {
      const insert = "INSERT INTO t VALUES (1, 'a\tb\\c\nd''e\bf\fg\vh');\n";
      expect(findPlaintextLeaks(insert, [awkward])).toEqual([{ index: 0, encoding: "utf8" }]);
    });

    it("bytea_output = escape: non-printable bytes as octal, backslash doubled", () => {
      // What pg_dump writes for convert_to(awkward, 'UTF8') in escape mode, COPY then INSERT.
      const escaped = "a\\011b\\\\c\\012d'e\\010f\\014g\\013h";
      const copy = "1\t" + escaped.replace(/\\/g, "\\\\") + "\n";
      const insert = "INSERT INTO t VALUES (1, '" + escaped.replace(/'/g, "''") + "');\n";
      expect(findPlaintextLeaks(copy, [awkward])).toEqual([{ index: 0, encoding: "escape" }]);
      expect(findPlaintextLeaks(insert, [awkward])).toEqual([{ index: 0, encoding: "escape" }]);
      expect(findPlaintextLeaks(copy, [secret])).toEqual([]);
    });
  });

  describe("bytea literals holding a self-describing ciphertext (review, MAJOR)", () => {
    it("decodes a COPY hex literal and then the rk1: payload", () => {
      const dump = `1\t\\x${hexOf(fakeCiphertext(secret))}\n`;
      expect(findPlaintextLeaks(dump, [secret, other])).toEqual([
        { index: 0, encoding: "decoded" },
      ]);
    });

    it("decodes an INSERT hex literal and then the rk1: payload", () => {
      const dump = `INSERT INTO m VALUES ('\\x${hexOf(fakeCiphertext(other))}', 1);\n`;
      expect(findPlaintextLeaks(dump, [secret, other])).toEqual([
        { index: 1, encoding: "decoded" },
      ]);
    });

    it("finds a rk1: payload that sits directly in the text (escape mode or a text column)", () => {
      // In text form the plain base64url search already covers every alignment of the body;
      // the decoding step matters once the value is hidden inside a bytea hex literal.
      expect(findPlaintextLeaks(`1\t${fakeCiphertext(secret)}\n`, [secret])).toEqual([
        { index: 0, encoding: "base64" },
      ]);
      const shifted =
        "rk1:" + Buffer.concat([Buffer.alloc(33), Buffer.from(secret)]).toString("base64url");
      expect(findPlaintextLeaks(`1\t${shifted}\n`, [secret])).toEqual([
        { index: 0, encoding: "base64" },
      ]);
    });

    it("decodes a rkw1: payload inside a hex literal", () => {
      const wrapped = `rkw1:1:v1:${Buffer.from(secret).toString("base64url")}`;
      expect(findPlaintextLeaks(`1\t\\x${hexOf(wrapped)}\n`, [secret])).toEqual([
        { index: 0, encoding: "decoded" },
      ]);
    });

    it("finds a secret base64-encoded inside a hex literal", () => {
      const inner = Buffer.from(secret).toString("base64");
      expect(findPlaintextLeaks(`'\\x${hexOf(inner)}'`, [secret])).toEqual([
        { index: 0, encoding: "decoded" },
      ]);
    });

    it("decodes a bytea whose bytes are the secret itself", () => {
      expect(findPlaintextLeaks(`1\t\\x${hexOf(secret)}\n`, [secret])).toEqual([
        { index: 0, encoding: "hex" },
      ]);
    });

    it("stays quiet on a real-looking ciphertext of random bytes", () => {
      const random = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 97 + 5) & 0xff));
      const value = "rk1:" + random.toString("base64url");
      expect(findPlaintextLeaks(`1\t\\x${hexOf(value)}\n`, [secret, other])).toEqual([]);
    });
  });
});

describe("expandDump", () => {
  it("appends every decoded bytea literal and every rk1:/rkw1: payload to the dump", () => {
    const dek = Buffer.from("k".repeat(32));
    const wrapped = `rkw1:1:v1:${dek.toString("base64url")}`;
    const dump = `1\t\\x${hexOf(wrapped)}\t'\\x${hexOf(fakeCiphertext(secret))}'\n`;
    const expanded = expandDump(dump);
    expect(expanded.subarray(0, Buffer.byteLength(dump)).toString("utf8")).toBe(dump);
    const tail = expanded.toString("latin1");
    expect(tail).toContain(wrapped);
    expect(tail).toContain(fakeCiphertext(secret));
    expect(tail).toContain(secret);
    expect(expanded.includes(dek)).toBe(true);
  });

  it("leaves a dump without encodings as it is, plus a newline", () => {
    expect(expandDump("plain").toString()).toBe("plain\n");
  });
});

describe("findKeyMaterial / assertNoKeyMaterial", () => {
  const dek = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff));

  it("finds a raw key in a text dump read as latin1", () => {
    expect(findKeyMaterial(`x ${dek.toString("latin1")} y`, [dek])).toEqual([
      { index: 0, encoding: "raw" },
    ]);
  });

  it("ignores empty keys", () => {
    expect(findKeyMaterial("anything", [new Uint8Array(0)])).toEqual([]);
  });

  it("passes on a dump that holds only a wrapped key", () => {
    const wrapped = `rkw1:1:v1:${Buffer.alloc(60, 7).toString("base64url")}`;
    expect(findKeyMaterial(`1\t\\x${hexOf(wrapped)}\n`, [dek])).toEqual([]);
    expect(() => assertNoKeyMaterial("rk1:AAAA", [dek])).not.toThrow();
  });

  it("finds raw, hex, base64 and base64url forms", () => {
    const raw = Buffer.concat([Buffer.from("x "), dek, Buffer.from(" y")]);
    expect(findKeyMaterial(raw, [dek])).toEqual([{ index: 0, encoding: "raw" }]);
    expect(findKeyMaterial(`1\t\\x${dek.toString("hex")}\n`, [dek])).toEqual([
      { index: 0, encoding: "hex" },
    ]);
    expect(findKeyMaterial(dek.toString("hex").toUpperCase(), [dek])).toEqual([
      { index: 0, encoding: "hex" },
    ]);
    expect(findKeyMaterial(`v1=${dek.toString("base64")}`, [dek])).toEqual([
      { index: 0, encoding: "base64" },
    ]);
    expect(findKeyMaterial(dek.toString("base64url"), [dek])).toEqual([
      { index: 0, encoding: "base64url" },
    ]);
  });

  it("finds a data key stored 'wrapped' by an identity wrapper inside a bytea literal", () => {
    const wrapped = `rkw1:1:v1:${dek.toString("base64url")}`;
    const copy = `1\t\\x${hexOf(wrapped)}\n`;
    const insert = `INSERT INTO orgs VALUES ('\\x${hexOf(wrapped)}', 1);\n`;
    expect(findKeyMaterial(copy, [Buffer.alloc(32, 1), dek])).toEqual([
      { index: 1, encoding: "decoded" },
    ]);
    expect(findKeyMaterial(insert, [dek])).toEqual([{ index: 0, encoding: "decoded" }]);
    // Hex of the raw key inside a bytea literal is found by the plain hex search.
    expect(findKeyMaterial(`'\\x${dek.toString("hex")}'`, [dek])).toEqual([
      { index: 0, encoding: "hex" },
    ]);
  });

  it("finds a key at any base64 alignment inside a larger blob", () => {
    for (const prefix of ["", "a", "ab"]) {
      const blob = Buffer.concat([Buffer.from(prefix), dek, Buffer.from("t")]).toString("base64");
      expect(findKeyMaterial(blob, [dek])).toEqual([{ index: 0, encoding: "base64" }]);
    }
  });

  it("throws naming the key by index only", () => {
    let caught: Error | undefined;
    try {
      assertNoKeyMaterial(dek.toString("hex"), [Buffer.alloc(32, 2), dek]);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe("key material found in dump: #1 (hex)");
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
