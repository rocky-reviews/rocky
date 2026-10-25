import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors.js";
import { LocalKeyWrapper, type KeyWrapper } from "./key-wrapper.js";
import {
  CIPHERTEXT_PREFIX,
  OrgKeyring,
  decodeWrappedDataKey,
  encodeWrappedDataKey,
  generateWrappedDataKey,
  isCiphertext,
  rewrapDataKeys,
  rotateDataKey,
  type WrappedDataKey,
} from "./keyring.js";

const kekA = randomBytes(32);
const kekB = randomBytes(32);
const wrapper = new LocalKeyWrapper({ k1: kekA });
const ORG = "0b7f2a1e-6c4d-4e0b-9f3a-1d2e3f4a5b6c";
const ctx = { purpose: "github_token", recordId: "member-42" } as const;
const token = "gho_" + "x".repeat(36);

const openFresh = async () => {
  const keys = [await generateWrappedDataKey(wrapper, ORG)];
  return { keys, keyring: await OrgKeyring.open(wrapper, ORG, keys) };
};

describe("OrgKeyring", () => {
  it("encrypts to a versioned, prefixed ciphertext and decrypts it back", async () => {
    const { keyring } = await openFresh();
    const ct = keyring.encrypt(token, ctx);
    expect(ct.startsWith(CIPHERTEXT_PREFIX)).toBe(true);
    expect(isCiphertext(ct)).toBe(true);
    expect(ct).not.toContain(token);
    expect(keyring.decryptToString(ct, ctx)).toBe(token);
    expect(keyring.decrypt(ct, ctx).equals(Buffer.from(token))).toBe(true);
  });

  it("produces different ciphertexts for the same plaintext (random nonce)", async () => {
    const { keyring } = await openFresh();
    expect(keyring.encrypt(token, ctx)).not.toBe(keyring.encrypt(token, ctx));
  });

  it("starts at data-key version 1", async () => {
    const { keyring } = await openFresh();
    expect(keyring.currentVersion).toBe(1);
    expect(keyring.versions).toEqual([1]);
  });

  it("rejects a ciphertext moved to another record or purpose", async () => {
    const { keyring } = await openFresh();
    const ct = keyring.encrypt(token, ctx);
    expect(() => keyring.decrypt(ct, { ...ctx, recordId: "member-43" })).toThrow(
      expect.objectContaining({ code: "authentication_failed" }),
    );
    expect(() => keyring.decrypt(ct, { ...ctx, purpose: "byok_key" })).toThrow(
      expect.objectContaining({ code: "authentication_failed" }),
    );
  });

  it("rejects a ciphertext moved to another org, even with the same data key", async () => {
    // Simulate an attacker who copies an org's DEK blob and a ciphertext row to another org.
    const { keys, keyring } = await openFresh();
    const ct = keyring.encrypt(token, ctx);
    const dek = await wrapper.unwrap(keys[0]!.blob, keys[0]!.kekVersion, {
      orgId: ORG,
      dataKeyVersion: 1,
    });
    const otherOrg = "f1e2d3c4-b5a6-4789-8abc-def012345678";
    const wrappedForOther = await wrapper.wrap(dek, { orgId: otherOrg, dataKeyVersion: 1 });
    const other = await OrgKeyring.open(wrapper, otherOrg, [{ version: 1, ...wrappedForOther }]);
    expect(() => other.decrypt(ct, ctx)).toThrow(
      expect.objectContaining({ code: "authentication_failed" }),
    );
  });

  it("refuses to open a wrapped key that belongs to another org", async () => {
    const { keys } = await openFresh();
    await expect(OrgKeyring.open(wrapper, "another-org", keys)).rejects.toMatchObject({
      code: "authentication_failed",
    });
  });

  it("rejects malformed and unsupported ciphertexts with typed errors", async () => {
    const { keyring } = await openFresh();
    const ct = keyring.encrypt(token, ctx);
    const cases: [string, string][] = [
      ["", "malformed_ciphertext"],
      ["not a ciphertext", "malformed_ciphertext"],
      [`${CIPHERTEXT_PREFIX}`, "malformed_ciphertext"],
      [`${CIPHERTEXT_PREFIX}AAAA`, "malformed_ciphertext"],
      [`${CIPHERTEXT_PREFIX}${"!".repeat(60)}`, "malformed_ciphertext"],
      [ct.replace("rk1:", "rk2:"), "unsupported_format"],
      [ct.replace("rk1:", "RK1:"), "malformed_ciphertext"],
    ];
    for (const [input, code] of cases) {
      expect(() => keyring.decrypt(input, ctx)).toThrow(expect.objectContaining({ code }));
    }
    // Appending characters either breaks canonical base64url or lengthens the body: typed either way.
    expect(() => keyring.decrypt(ct + "A", ctx)).toThrow(CryptoError);
    expect(() => keyring.decrypt(ct + "AAAA", ctx)).toThrow(CryptoError);
    expect(isCiphertext("plain")).toBe(false);
  });

  it("rejects a ciphertext for a data-key version it does not hold", async () => {
    const { keys } = await openFresh();
    const rotated = await rotateDataKey(wrapper, ORG, keys);
    const full = await OrgKeyring.open(wrapper, ORG, rotated);
    const ct = full.encrypt(token, ctx);
    const onlyOld = await OrgKeyring.open(wrapper, ORG, keys);
    expect(() => onlyOld.decrypt(ct, ctx)).toThrow(
      expect.objectContaining({ code: "unknown_key_version" }),
    );
  });

  it("validates the record context", async () => {
    const { keyring } = await openFresh();
    expect(() => keyring.encrypt(token, { ...ctx, recordId: "" })).toThrow(
      expect.objectContaining({ code: "invalid_context" }),
    );
    expect(() => keyring.encrypt(token, { purpose: "" as "github_token", recordId: "x" })).toThrow(
      expect.objectContaining({ code: "invalid_context" }),
    );
  });

  it("zeroes data keys on destroy and refuses further use", async () => {
    // A wrapper double that remembers the buffers it hands out, so the test can inspect them.
    const handedOut: Buffer[] = [];
    const spying: KeyWrapper = {
      currentKekVersion: wrapper.currentKekVersion,
      wrap: (dek, c) => wrapper.wrap(dek, c),
      unwrap: async (blob, v, c) => {
        const dek = await wrapper.unwrap(blob, v, c);
        handedOut.push(dek);
        return dek;
      },
    };
    const keys = [await generateWrappedDataKey(wrapper, ORG)];
    const keyring = await OrgKeyring.open(spying, ORG, keys);
    const ct = keyring.encrypt(token, ctx);
    expect(handedOut).toHaveLength(1);
    expect(handedOut[0]!.some((b) => b !== 0)).toBe(true);
    keyring.destroy();
    expect(handedOut.every((buf) => buf.every((b) => b === 0))).toBe(true);
    expect(() => keyring.decrypt(ct, ctx)).toThrow(
      expect.objectContaining({ code: "keyring_destroyed" }),
    );
    expect(() => keyring.encrypt(token, ctx)).toThrow(
      expect.objectContaining({ code: "keyring_destroyed" }),
    );
  });

  it("never includes the plaintext in any error", async () => {
    const { keyring } = await openFresh();
    const ct = keyring.encrypt(token, ctx);
    let caught: unknown;
    try {
      keyring.decrypt(ct, { ...ctx, recordId: "other" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught as object))).not.toContain(
      token,
    );
  });
});

describe("data-key rotation (new DEK version)", () => {
  it("keeps old ciphertexts readable, encrypts new ones under the new version", async () => {
    const { keys, keyring: before } = await openFresh();
    const oldCt = before.encrypt(token, ctx);

    const rotated = await rotateDataKey(wrapper, ORG, keys);
    expect(rotated.map((k) => k.version)).toEqual([1, 2]);
    expect(rotated[0]).toEqual(keys[0]);

    const after = await OrgKeyring.open(wrapper, ORG, rotated);
    expect(after.currentVersion).toBe(2);
    expect(after.decryptToString(oldCt, ctx)).toBe(token);
    const newCt = after.encrypt(token, ctx);
    expect(after.decryptToString(newCt, ctx)).toBe(token);
    // A keyring that only has the old version still works while rows are migrating...
    expect(before.decryptToString(oldCt, ctx)).toBe(token);
    // ...but cannot read rows already moved to the new version.
    expect(() => before.decrypt(newCt, ctx)).toThrow(
      expect.objectContaining({ code: "unknown_key_version" }),
    );
  });

  it("re-encrypts a ciphertext under the current version and is a no-op when it already is", async () => {
    const { keys, keyring: before } = await openFresh();
    const oldCt = before.encrypt(token, ctx);
    const after = await OrgKeyring.open(wrapper, ORG, await rotateDataKey(wrapper, ORG, keys));

    const moved = after.reencrypt(oldCt, ctx);
    expect(moved).not.toBe(oldCt);
    expect(after.decryptToString(moved, ctx)).toBe(token);
    expect(after.reencrypt(moved, ctx)).toBe(moved);

    // Once every row is moved, the old version can be retired.
    const retired = await OrgKeyring.open(
      wrapper,
      ORG,
      (await rotateDataKey(wrapper, ORG, keys)).filter((k) => k.version === 2),
    );
    expect(() => retired.decrypt(oldCt, ctx)).toThrow(
      expect.objectContaining({ code: "unknown_key_version" }),
    );
  });

  it("re-encryption still authenticates the context", async () => {
    const { keys, keyring: before } = await openFresh();
    const oldCt = before.encrypt(token, ctx);
    const after = await OrgKeyring.open(wrapper, ORG, await rotateDataKey(wrapper, ORG, keys));
    expect(() => after.reencrypt(oldCt, { ...ctx, recordId: "member-1" })).toThrow(
      expect.objectContaining({ code: "authentication_failed" }),
    );
  });

  it("rejects an empty key set and duplicate versions", async () => {
    await expect(OrgKeyring.open(wrapper, ORG, [])).rejects.toMatchObject({
      code: "invalid_key",
    });
    const { keys } = await openFresh();
    await expect(OrgKeyring.open(wrapper, ORG, [...keys, ...keys])).rejects.toMatchObject({
      code: "invalid_key",
    });
    await expect(rotateDataKey(wrapper, ORG, [])).rejects.toMatchObject({ code: "invalid_key" });
  });
});

describe("KEK rotation (re-wrap)", () => {
  it("re-wraps data keys under the current KEK without changing ciphertexts", async () => {
    const { keys, keyring } = await openFresh();
    const ct = keyring.encrypt(token, ctx);

    // Step 1: deploy the new KEK alongside the old one; everyone can still unwrap.
    const transition = new LocalKeyWrapper({ k1: kekA, k2: kekB }, "k2");
    const rewrapped = await rewrapDataKeys(transition, ORG, keys);
    expect(rewrapped.map((k) => k.kekVersion)).toEqual(["k2"]);
    expect(rewrapped.map((k) => k.version)).toEqual([1]);
    expect(Buffer.from(rewrapped[0]!.blob).equals(Buffer.from(keys[0]!.blob))).toBe(false);

    // During rotation, a node with both KEKs reads old and new wrapped keys.
    const during = await OrgKeyring.open(transition, ORG, rewrapped);
    expect(during.decryptToString(ct, ctx)).toBe(token);
    expect((await OrgKeyring.open(transition, ORG, keys)).decryptToString(ct, ctx)).toBe(token);

    // Step 2: retire the old KEK; only re-wrapped keys open.
    const onlyNew = new LocalKeyWrapper({ k2: kekB });
    expect((await OrgKeyring.open(onlyNew, ORG, rewrapped)).decryptToString(ct, ctx)).toBe(token);
    await expect(OrgKeyring.open(onlyNew, ORG, keys)).rejects.toMatchObject({
      code: "unknown_key_version",
    });
  });

  it("leaves keys already wrapped with the current KEK untouched", async () => {
    const { keys } = await openFresh();
    const again = await rewrapDataKeys(wrapper, ORG, keys);
    expect(again).toEqual(keys);
  });
});

describe("wrapped data key encoding", () => {
  it("round-trips through the storable string form", async () => {
    const key = await generateWrappedDataKey(wrapper, ORG, 7);
    const text = encodeWrappedDataKey(key);
    expect(text.startsWith("rkw1:7:k1:")).toBe(true);
    const back = decodeWrappedDataKey(text);
    expect(back.version).toBe(7);
    expect(back.kekVersion).toBe("k1");
    expect(Buffer.from(back.blob).equals(Buffer.from(key.blob))).toBe(true);
  });

  it.each([
    "",
    "rkw1:",
    "rkw2:1:k1:AAAA",
    "rkw1:x:k1:AAAA",
    "rkw1:0:k1:AAAA",
    "rkw1:1::AAAA",
    "rkw1:1:bad id:AAAA",
    "rkw1:1:k1:",
    "rkw1:1:k1:***",
    "rkw1:1:k1:AAAA:extra",
  ])("rejects malformed wrapped key %j", (input) => {
    expect(() => decodeWrappedDataKey(input)).toThrow(CryptoError);
  });

  it("rejects invalid version numbers on encode", () => {
    const bad: WrappedDataKey = { version: 1.5, kekVersion: "k1", blob: new Uint8Array(4) };
    expect(() => encodeWrappedDataKey(bad)).toThrow(
      expect.objectContaining({ code: "invalid_key" }),
    );
  });
});
