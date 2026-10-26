/** Regression tests for the independent review of P2-3; one `describe` per finding. */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encodeAad } from "./aad.js";
import { open, seal } from "./aead.js";
import { CryptoError } from "./errors.js";
import { KEK_KEYS_ENV, LocalKeyWrapper, localKeyWrapperFromEnv } from "./key-wrapper.js";
import { decodeWrappedDataKey } from "./keyring.js";
import { findPlaintextLeaks } from "./testing.js";

const b64 = (buf: Uint8Array) => Buffer.from(buf).toString("base64");

describe("F1: open() zeroes the intermediate plaintext chunks", () => {
  it("every chunk handed to Buffer.concat is zero after open returns", () => {
    const key = randomBytes(32);
    const aad = encodeAad(["org", "github_token", "r1"]);
    const plaintext = randomBytes(77);
    const sealed = seal(key, plaintext, aad);

    const captured: Uint8Array[] = [];
    const original = Buffer.concat.bind(Buffer);
    const spy = vi.spyOn(Buffer, "concat").mockImplementation((list, total) => {
      captured.push(...list);
      return original(list, total);
    });
    try {
      const out = open(key, sealed, aad);
      expect(out.equals(plaintext)).toBe(true);
      expect(captured.length).toBeGreaterThan(0);
      expect(captured.some((c) => c.length > 0)).toBe(true);
      for (const chunk of captured) expect(chunk.every((b) => b === 0)).toBe(true);
      expect(captured).not.toContain(out);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("F2: weak KEKs are rejected", () => {
  it.each([
    ["all zero", Buffer.alloc(32)],
    ["all same byte", Buffer.alloc(32, 0xab)],
    ["two alternating bytes", Buffer.from(Array.from({ length: 32 }, (_, i) => i % 2))],
    ["eight distinct bytes", Buffer.from(Array.from({ length: 32 }, (_, i) => i % 8))],
    ["ascii digits only", Buffer.from("01234567890123456789012345678901")],
  ])("rejects a %s key in the constructor and from the environment", (_name, key) => {
    expect(() => new LocalKeyWrapper({ v1: key })).toThrow(
      expect.objectContaining({ code: "invalid_key" }),
    );
    expect(() => localKeyWrapperFromEnv({ [KEK_KEYS_ENV]: `v1=${b64(key)}` })).toThrow(
      expect.objectContaining({ code: "invalid_key" }),
    );
  });

  it("accepts random keys and still requires exactly 32 bytes", () => {
    expect(() => new LocalKeyWrapper({ v1: randomBytes(32) })).not.toThrow();
    expect(() => new LocalKeyWrapper({ v1: randomBytes(33) })).toThrow(CryptoError);
  });
});

describe("F3: the current KEK is the last one listed, whatever the id", () => {
  const a = randomBytes(32);
  const b = randomBytes(32);

  it("integer-like ids keep their listed order", () => {
    const wrapper = localKeyWrapperFromEnv({ [KEK_KEYS_ENV]: `10=${b64(a)},9=${b64(b)}` });
    expect(wrapper.kekVersions).toEqual(["10", "9"]);
    expect(wrapper.currentKekVersion).toBe("9");
    expect(
      new LocalKeyWrapper([
        ["10", a],
        ["9", b],
      ]).currentKekVersion,
    ).toBe("9");
  });

  it("prototype property names are ordinary ids, not duplicates", async () => {
    const wrapper = localKeyWrapperFromEnv({ [KEK_KEYS_ENV]: `toString=${b64(a)}` });
    expect(wrapper.currentKekVersion).toBe("toString");
    const dek = randomBytes(32);
    const ctx = { orgId: "o", dataKeyVersion: 1 };
    const wrapped = await wrapper.wrap(dek, ctx);
    expect((await wrapper.unwrap(wrapped.blob, "toString", ctx)).equals(dek)).toBe(true);
    expect(() => localKeyWrapperFromEnv({ [KEK_KEYS_ENV]: `v1=${b64(a)},v1=${b64(b)}` })).toThrow(
      expect.objectContaining({ code: "invalid_key" }),
    );
  });
});

describe("F4: the wrapper copies caller key buffers", () => {
  it("destroy() does not zero the caller's buffer, and the caller cannot alter the wrapper's key", async () => {
    const mine = randomBytes(32);
    const expected = Buffer.from(mine);
    const wrapper = new LocalKeyWrapper({ v1: mine });
    const ctx = { orgId: "o", dataKeyVersion: 1 };
    const dek = randomBytes(32);
    const wrapped = await wrapper.wrap(dek, ctx);
    mine.fill(0);
    expect((await wrapper.unwrap(wrapped.blob, "v1", ctx)).equals(dek)).toBe(true);
    wrapper.destroy();
    expect(mine.every((x) => x === 0)).toBe(true);
    const other = new LocalKeyWrapper({ v1: expected });
    expect((await other.unwrap(wrapped.blob, "v1", ctx)).equals(dek)).toBe(true);
  });
});

describe("F5: wrapped-key versions are bounded to u32", () => {
  it("rejects versions above MAX_VERSION and accepts MAX_VERSION", () => {
    expect(() => decodeWrappedDataKey("rkw1:4294967296:k1:AAAA")).toThrow(CryptoError);
    expect(() => decodeWrappedDataKey("rkw1:99999999999:k1:AAAA")).toThrow(CryptoError);
    expect(decodeWrappedDataKey("rkw1:4294967295:k1:AAAA").version).toBe(4294967295);
  });
});

describe("F6: the dump helper sees through pg_dump COPY escaping", () => {
  const pem = [
    ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
    "MIIB" + "x".repeat(60),
    "y".repeat(64),
    ["-----END", "RSA PRIVATE KEY-----"].join(" "),
  ].join("\n");
  const copyEscape = (text: string) =>
    text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\r/g, "\\r");

  it("finds a multi-line PEM key stored as text", () => {
    const dump = `COPY keys (id, pem) FROM stdin;\n1\t${copyEscape(pem)}\n\\.\n`;
    expect(dump).not.toContain(pem);
    expect(findPlaintextLeaks(dump, [pem])).toEqual([{ index: 0, encoding: "utf8" }]);
  });

  it("finds secrets with tabs and backslashes", () => {
    const secret = "a\tb\\c\rd";
    expect(findPlaintextLeaks(`1\t${copyEscape(secret)}\n`, [secret])).toEqual([
      { index: 0, encoding: "utf8" },
    ]);
  });

  it("still passes a clean dump", () => {
    expect(findPlaintextLeaks("1\trk1:AAAA\\nBBBB\n", [pem])).toEqual([]);
  });
});
