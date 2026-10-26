import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CryptoError } from "./errors.js";
import {
  KEK_CURRENT_ENV,
  KEK_KEYS_ENV,
  LocalKeyWrapper,
  generateLocalKek,
  localKeyWrapperFromEnv,
} from "./key-wrapper.js";

const kek1 = randomBytes(32);
const kek2 = randomBytes(32);
const ctx = { orgId: "org-a", dataKeyVersion: 1 };

describe("LocalKeyWrapper", () => {
  it("wraps with the current KEK version and unwraps the same bytes", async () => {
    const wrapper = new LocalKeyWrapper({ v1: kek1 });
    const dek = randomBytes(32);
    const wrapped = await wrapper.wrap(dek, ctx);
    expect(wrapped.kekVersion).toBe("v1");
    expect(Buffer.from(wrapped.blob).includes(dek)).toBe(false);
    const unwrapped = await wrapper.unwrap(wrapped.blob, wrapped.kekVersion, ctx);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("binds the wrapped key to the org and data-key version", async () => {
    const wrapper = new LocalKeyWrapper({ v1: kek1 });
    const wrapped = await wrapper.wrap(randomBytes(32), ctx);
    await expect(
      wrapper.unwrap(wrapped.blob, "v1", { ...ctx, orgId: "org-b" }),
    ).rejects.toMatchObject({ code: "authentication_failed" });
    await expect(
      wrapper.unwrap(wrapped.blob, "v1", { ...ctx, dataKeyVersion: 2 }),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("uses the explicit current version for wrapping and all versions for unwrapping", async () => {
    const both = new LocalKeyWrapper({ v1: kek1, v2: kek2 }, "v1");
    const dek = randomBytes(32);
    const wrapped = await both.wrap(dek, ctx);
    expect(wrapped.kekVersion).toBe("v1");

    const rotated = new LocalKeyWrapper({ v1: kek1, v2: kek2 }, "v2");
    expect(rotated.currentKekVersion).toBe("v2");
    expect((await rotated.unwrap(wrapped.blob, "v1", ctx)).equals(dek)).toBe(true);
    const rewrapped = await rotated.wrap(dek, ctx);
    expect(rewrapped.kekVersion).toBe("v2");

    const onlyNew = new LocalKeyWrapper({ v2: kek2 });
    await expect(onlyNew.unwrap(wrapped.blob, "v1", ctx)).rejects.toMatchObject({
      code: "unknown_key_version",
    });
    expect((await onlyNew.unwrap(rewrapped.blob, "v2", ctx)).equals(dek)).toBe(true);
  });

  it("defaults the current version to the last key listed", () => {
    expect(new LocalKeyWrapper({ v1: kek1, v2: kek2 }).currentKekVersion).toBe("v2");
  });

  it("rejects a current version that is not in the key set", () => {
    expect(() => new LocalKeyWrapper({ v1: kek1 }, "v9")).toThrow(
      expect.objectContaining({ code: "unknown_key_version" }),
    );
  });

  it("rejects KEKs that are not 32 bytes, bad version ids and empty sets", () => {
    expect(() => new LocalKeyWrapper({ v1: randomBytes(16) })).toThrow(CryptoError);
    expect(() => new LocalKeyWrapper({ "bad id": kek1 })).toThrow(
      expect.objectContaining({ code: "invalid_key" }),
    );
    expect(() => new LocalKeyWrapper({})).toThrow(expect.objectContaining({ code: "invalid_key" }));
  });

  it("rejects wrapping anything but a 32-byte DEK and malformed blobs", async () => {
    const wrapper = new LocalKeyWrapper({ v1: kek1 });
    await expect(wrapper.wrap(randomBytes(16), ctx)).rejects.toMatchObject({
      code: "invalid_key",
    });
    await expect(wrapper.unwrap(randomBytes(10), "v1", ctx)).rejects.toMatchObject({
      code: "malformed_ciphertext",
    });
  });

  it("refuses further use after destroy and leaves the caller's buffer alone", async () => {
    const mine = Buffer.from(kek1);
    const wrapper = new LocalKeyWrapper({ v1: mine });
    const wrapped = await wrapper.wrap(randomBytes(32), ctx);
    wrapper.destroy();
    expect(mine.equals(kek1)).toBe(true);
    await expect(wrapper.wrap(randomBytes(32), ctx)).rejects.toMatchObject({
      code: "keyring_destroyed",
    });
    await expect(wrapper.unwrap(wrapped.blob, "v1", ctx)).rejects.toMatchObject({
      code: "keyring_destroyed",
    });
  });
});

describe("localKeyWrapperFromEnv", () => {
  const b64 = (buf: Buffer) => buf.toString("base64");

  it("parses `id=base64` entries and an explicit current id", () => {
    const wrapper = localKeyWrapperFromEnv({
      [KEK_KEYS_ENV]: `v1=${b64(kek1)}, v2=${b64(kek2)}`,
      [KEK_CURRENT_ENV]: "v1",
    });
    expect(wrapper.currentKekVersion).toBe("v1");
    expect(wrapper.kekVersions).toEqual(["v1", "v2"]);
  });

  it("accepts a value produced by generateLocalKek", () => {
    const wrapper = localKeyWrapperFromEnv({ [KEK_KEYS_ENV]: `dev=${generateLocalKek()}` });
    expect(wrapper.currentKekVersion).toBe("dev");
  });

  it.each([
    ["missing", {}],
    ["empty", { [KEK_KEYS_ENV]: "" }],
    ["no id", { [KEK_KEYS_ENV]: b64(kek1) }],
    ["wrong length", { [KEK_KEYS_ENV]: `v1=${b64(randomBytes(31))}` }],
    ["not base64", { [KEK_KEYS_ENV]: "v1=***not-base64***" }],
    ["duplicate id", { [KEK_KEYS_ENV]: `v1=${b64(kek1)},v1=${b64(kek2)}` }],
  ])("rejects a %s key set with a typed error", (_name, env) => {
    expect(() => localKeyWrapperFromEnv(env)).toThrow(CryptoError);
  });

  it("never echoes the key bytes in the error", () => {
    const value = b64(randomBytes(20));
    let caught: unknown;
    try {
      localKeyWrapperFromEnv({ [KEK_KEYS_ENV]: `v1=${value}` });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CryptoError);
    expect(String((caught as Error).message)).not.toContain(value);
  });
});
