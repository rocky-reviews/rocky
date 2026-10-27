import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import {
  CIPHERTEXT_PREFIX as CRYPTO_CIPHERTEXT_PREFIX,
  MIN_CIPHERTEXT_BYTES as CRYPTO_MIN_CIPHERTEXT_BYTES,
  decodeWrappedDataKey,
  encodeWrappedDataKey,
  isCryptoError,
  LocalKeyWrapper,
  OrgKeyring,
  generateLocalKek,
  type WrappedDataKey,
} from "@rocky-reviews/crypto";
import {
  assertNoKeyMaterial,
  assertNoPlaintextLeaks,
  findKeyMaterial,
  findPlaintextLeaks,
} from "@rocky-reviews/crypto/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, TenantContextError, type Db, type TenantTx } from "./client.js";
import * as schema from "./schema.js";
import {
  CIPHERTEXT_PREFIX,
  loadForgeToken,
  loadOrgDataKey,
  loadOrgLlmApiKey,
  MIN_CIPHERTEXT_BYTES,
  replaceOrgDataKey,
  SecretStoreError,
  storeForgeToken,
  storeOrgDataKey,
  storeOrgLlmApiKey,
  WRAPPED_KEY_PREFIX,
} from "./secrets.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  type DumpOptions,
  type SeededOrg,
  ignoreIdleError,
} from "./testing/index.js";

/**
 * P2-3 acceptance criterion "DB dump contains no plaintext tokens (test greps a dump)".
 *
 * Two orgs get their own data key (DEK), wrapped by a `LocalKeyWrapper` KEK, and realistic fake
 * secrets encrypted under those DEKs are written to the `*_ciphertext` columns of `orgs` and
 * `members` through the `secrets.ts` helpers. A real `pg_dump --format=plain` (COPY and INSERT
 * syntax, hex and escape `bytea_output`: four encodings of the same rows) is then searched for
 * every secret, every DEK and the KEK. The search decodes what a dump may hide behind an
 * encoding first: bytea hex literals, and the base64url payload of every `rk1:`/`rkw1:` value
 * (`expandDump` in `@rocky-reviews/crypto/testing`). Positive controls write plaintext through
 * the real columns and helpers (an identity-wrapped DEK, a `rk1:` value whose payload is the
 * token) and into a throwaway table, and prove the search finds them, so a passing run is not
 * vacuous. Every fake secret is assembled at runtime so no token-shaped literal exists in the
 * source tree.
 */

// --- Fake secrets, built at runtime (see packages/log/src/fixtures.ts for the rationale) ----

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const chars = (length: number, seed: number): string =>
  Array.from({ length }, (_, i) => CHARS[(i * seed + 3) % CHARS.length]).join("");

const pem = (): string =>
  [
    ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" "),
    chars(64, 3),
    chars(64, 5),
    chars(40, 7) + "==",
    ["-----END", "RSA PRIVATE KEY-----"].join(" "),
  ].join("\n");

const SECRETS = {
  /** GitHub App installation token. */
  installationToken: "ghs_" + chars(36, 13),
  /** GitHub user-to-server OAuth token. */
  userToken: "ghu_" + chars(36, 17),
  /** Anthropic-style BYOK key. */
  byokKey: ["sk-ant", "api03", chars(93, 29) + "AA"].join("-"),
  /** Multi-line PEM private key (newlines are escaped differently by COPY and INSERT dumps). */
  privateKey: pem(),
  /** A tab, a backslash and a quote: COPY escapes the first two, INSERT doubles the third. */
  awkward: "webhook'" + "\t" + chars(20, 31) + "\\" + chars(12, 37),
  /** The remaining control characters COPY escapes (\b, \f, \v) and escape-mode bytea renders as octal. */
  control: "pw" + "\b" + chars(8, 41) + "\f" + chars(8, 43) + "\v" + chars(8, 47),
} as const;
const SECRET_LIST: readonly string[] = Object.values(SECRETS);
const index = (name: keyof typeof SECRETS): number => Object.keys(SECRETS).indexOf(name);

/** A `rk1:` value with a valid header (version 1, zero nonce and tag) and `body` as payload. */
const fakeCiphertext = (body: Buffer | string, version = 1): string => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(version);
  return (
    CIPHERTEXT_PREFIX +
    Buffer.concat([header, Buffer.alloc(28), Buffer.from(body)]).toString("base64url")
  );
};

/** The four ways pg_dump renders the same rows. */
const DUMP_FORMS: [string, DumpOptions][] = [
  ["COPY, hex bytea", { inserts: false, byteaOutput: "hex" }],
  ["INSERT, hex bytea", { inserts: true, byteaOutput: "hex" }],
  ["COPY, escape bytea", { inserts: false, byteaOutput: "escape" }],
  ["INSERT, escape bytea", { inserts: true, byteaOutput: "escape" }],
];

// --- Harness ---------------------------------------------------------------------------------

const KEK_VERSION = "v1";

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let superuser: pg.Pool;
let db: Db;
let wrapper: LocalKeyWrapper;
/** The KEK in the two forms an operator handles it: raw bytes and the `ROCKY_KEK_KEYS` base64. */
let kek: Buffer;
let a: SeededOrg;
let b: SeededOrg;
/** For the insert-once / compare-and-swap tests. */
let c: SeededOrg;
/** For the positive controls through the real columns. */
let d: SeededOrg;
/** A second member of org B, holding the awkward token. */
let bSecondMemberId: string;
const deks = new Map<string, Buffer>();

/** Mints a DEK for `orgId` (keeping the raw bytes for the absence check) and stores it wrapped. */
const provisionDataKey = async (orgId: SeededOrg["orgId"]): Promise<WrappedDataKey> => {
  const dek = Buffer.alloc(32);
  randomBytes(32).copy(dek);
  deks.set(orgId, dek);
  const wrapped = { version: 1, ...(await wrapper.wrap(dek, { orgId, dataKeyVersion: 1 })) };
  await db.withOrg(orgId, (tx) => storeOrgDataKey(tx, encodeWrappedDataKey(wrapped), 1));
  return wrapped;
};

/** Opens the org's keyring from what is actually stored, not from an in-memory copy. */
const openStoredKeyring = async (orgId: SeededOrg["orgId"]): Promise<OrgKeyring> => {
  const stored = await db.withOrg(orgId, (tx) => loadOrgDataKey(tx));
  if (stored === null) throw new Error("no data key stored");
  const wrapped = decodeWrappedDataKey(stored.ciphertext);
  expect(wrapped.version).toBe(stored.keyVersion);
  return OrgKeyring.open(wrapper, orgId, [wrapped]);
};

const cryptoErrorCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (isCryptoError(error)) return error.code;
    throw error;
  }
  throw new Error("expected a CryptoError");
};

const caught = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};

/** A valid-looking wrapped key: `rkw1:<version>:v1:<60 bytes>` (the LocalKeyWrapper blob size). */
const fakeWrappedKey = (version = 1, blob: Buffer = Buffer.alloc(60, 9)): string =>
  `${WRAPPED_KEY_PREFIX}${version}:${KEK_VERSION}:${blob.toString("base64url")}`;

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 }).on("error", ignoreIdleError);
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  kek = Buffer.from(generateLocalKek(), "base64");
  wrapper = new LocalKeyWrapper([[KEK_VERSION, kek]]);
  [a, b, c, d] = await asWorker(pgs.workerUrl, async (w) => [
    await seedOrg(w, newOrgId()),
    await seedOrg(w, newOrgId()),
    await seedOrg(w, newOrgId()),
    await seedOrg(w, newOrgId()),
  ]);
  bSecondMemberId = await db.withOrg(b.orgId, async (tx) => {
    const [row] = await tx.db
      .insert(schema.members)
      .values({ forgeUserId: 1002, login: "bob", role: "member" })
      .returning({ id: schema.members.id });
    return row!.id;
  });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  wrapper?.destroy();
  for (const dek of deks.values()) dek.fill(0);
  await db?.close();
  await superuser?.end();
  await pgs?.stop();
});

describe("secrets at rest (P2-3)", () => {
  it("mirrors the crypto package's storage prefixes", () => {
    expect(CIPHERTEXT_PREFIX).toBe(CRYPTO_CIPHERTEXT_PREFIX);
    // The wrapped-key prefix is not exported by crypto; it is fixed by ADR 0006 §5.
    expect(WRAPPED_KEY_PREFIX).toBe("rkw1:");
  });

  it("stores wrapped data keys and encrypted secrets for two orgs", async () => {
    await provisionDataKey(a.orgId);
    await provisionDataKey(b.orgId);
    const ringA = await openStoredKeyring(a.orgId);
    const ringB = await openStoredKeyring(b.orgId);
    try {
      await db.withOrg(a.orgId, async (tx) => {
        await storeOrgLlmApiKey(
          tx,
          ringA.encrypt(SECRETS.byokKey, { purpose: "byok_key", recordId: a.orgId }),
          ringA.currentVersion,
        );
        await storeForgeToken(
          tx,
          a.memberId,
          ringA.encrypt(SECRETS.userToken, { purpose: "github_token", recordId: a.memberId }),
          ringA.currentVersion,
        );
      });
      await db.withOrg(b.orgId, async (tx) => {
        await storeOrgLlmApiKey(
          tx,
          ringB.encrypt(SECRETS.privateKey, { purpose: "byok_key", recordId: b.orgId }),
          ringB.currentVersion,
        );
        await storeForgeToken(
          tx,
          b.memberId,
          ringB.encrypt(SECRETS.installationToken, {
            purpose: "github_token",
            recordId: b.memberId,
          }),
          ringB.currentVersion,
        );
        await storeForgeToken(
          tx,
          bSecondMemberId,
          ringB.encrypt(SECRETS.awkward, {
            purpose: "webhook_secret",
            recordId: bSecondMemberId,
          }),
          ringB.currentVersion,
        );
      });
      // The control-character secret goes into org C's BYOK slot, encrypted under org B's key
      // for this test's purposes only (org C has no data key yet; the CAS tests give it one).
      await db.withOrg(c.orgId, (tx) =>
        storeOrgLlmApiKey(
          tx,
          ringB.encrypt(SECRETS.control, { purpose: "byok_key", recordId: c.orgId }),
          ringB.currentVersion,
        ),
      );
    } finally {
      ringA.destroy();
      ringB.destroy();
    }
    // Every secret column of the orgs under test is populated: the dump below has something
    // to leak. (The superuser, because the owner pool is under FORCE RLS and sees no rows.)
    const populated = await superuser.query<{ n: string }>(
      `select (select count(*) from orgs where data_key_ciphertext is not null)
            + (select count(*) from orgs where llm_api_key_ciphertext is not null)
            + (select count(*) from members where forge_token_ciphertext is not null) as n`,
    );
    expect(populated.rows[0]?.n).toBe("8");
  });

  it.each(DUMP_FORMS)(
    "a plain pg_dump (%s) holds no secret, data key or KEK",
    async (_, options) => {
      const dump = await pgs.dump(options);
      // Sanity: it is a full dump (about 70 KB here) that does carry the secret columns, as
      // ciphertext.
      expect(dump.length).toBeGreaterThan(20_000);
      expect(dump).toContain("CREATE TABLE public.members");
      if (options.byteaOutput === "escape") {
        expect(dump).toContain(CIPHERTEXT_PREFIX);
        expect(dump).toContain(WRAPPED_KEY_PREFIX);
      } else {
        expect(dump).toContain(Buffer.from(CIPHERTEXT_PREFIX, "utf8").toString("hex"));
        expect(dump).toContain(Buffer.from(WRAPPED_KEY_PREFIX, "utf8").toString("hex"));
      }

      assertNoPlaintextLeaks(dump, SECRET_LIST);
      expect(deks.size).toBe(2);
      // The KEK cannot reach the database through the wrapper (true by construction); the DEKs
      // can only reach it wrapped. The positive controls below show this check can fail.
      assertNoKeyMaterial(dump, [kek, ...deks.values()]);
      expect(dump).not.toContain(kek.toString("base64"));
    },
  );

  it("decrypts every stored secret back through the stored data keys (round trip)", async () => {
    const ringA = await openStoredKeyring(a.orgId);
    const ringB = await openStoredKeyring(b.orgId);
    try {
      const llmA = await db.withOrg(a.orgId, (tx) => loadOrgLlmApiKey(tx));
      const tokenA = await db.withOrg(a.orgId, (tx) => loadForgeToken(tx, a.memberId));
      const llmB = await db.withOrg(b.orgId, (tx) => loadOrgLlmApiKey(tx));
      const tokenB = await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, b.memberId));
      const tokenB2 = await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, bSecondMemberId));
      const llmC = await db.withOrg(c.orgId, (tx) => loadOrgLlmApiKey(tx));
      expect([llmA, tokenA, llmB, tokenB, tokenB2, llmC].every((s) => s?.keyVersion === 1)).toBe(
        true,
      );

      expect(
        ringA.decryptToString(llmA!.ciphertext, { purpose: "byok_key", recordId: a.orgId }),
      ).toBe(SECRETS.byokKey);
      expect(
        ringA.decryptToString(tokenA!.ciphertext, {
          purpose: "github_token",
          recordId: a.memberId,
        }),
      ).toBe(SECRETS.userToken);
      expect(
        ringB.decryptToString(llmB!.ciphertext, { purpose: "byok_key", recordId: b.orgId }),
      ).toBe(SECRETS.privateKey);
      expect(
        ringB.decryptToString(tokenB!.ciphertext, {
          purpose: "github_token",
          recordId: b.memberId,
        }),
      ).toBe(SECRETS.installationToken);
      expect(
        ringB.decryptToString(tokenB2!.ciphertext, {
          purpose: "webhook_secret",
          recordId: bSecondMemberId,
        }),
      ).toBe(SECRETS.awkward);
      expect(
        ringB.decryptToString(llmC!.ciphertext, { purpose: "byok_key", recordId: c.orgId }),
      ).toBe(SECRETS.control);
    } finally {
      ringA.destroy();
      ringB.destroy();
    }
  });

  it("refuses a ciphertext or wrapped key replayed into the other tenant", async () => {
    const tokenA = await db.withOrg(a.orgId, (tx) => loadForgeToken(tx, a.memberId));
    const ringB = await openStoredKeyring(b.orgId);
    try {
      // Same record id and purpose, other org: the AAD does not match.
      expect(
        cryptoErrorCode(() =>
          ringB.decrypt(tokenA!.ciphertext, { purpose: "github_token", recordId: a.memberId }),
        ),
      ).toBe("authentication_failed");
    } finally {
      ringB.destroy();
    }
    // Org A's wrapped DEK presented as org B's does not unwrap.
    const storedA = await db.withOrg(a.orgId, (tx) => loadOrgDataKey(tx));
    await expect(
      OrgKeyring.open(wrapper, b.orgId, [decodeWrappedDataKey(storedA!.ciphertext)]),
    ).rejects.toMatchObject({ code: "authentication_failed" });
  });

  it("cannot write a token into another tenant's member row (RLS, fails closed)", async () => {
    const before = await db.withOrg(a.orgId, (tx) => loadForgeToken(tx, a.memberId));
    await expect(
      db.withOrg(b.orgId, (tx) => storeForgeToken(tx, a.memberId, fakeCiphertext("x"), 1)),
    ).rejects.toThrow(/no such member/);
    const after = await db.withOrg(a.orgId, (tx) => loadForgeToken(tx, a.memberId));
    expect(after).toEqual(before);
    expect(await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, a.memberId))).toBeNull();
  });
});

describe("the helpers refuse what is not ciphertext, before any SQL (review #4)", () => {
  const valid = fakeCiphertext(Buffer.alloc(1));

  it("accepts the minimum real ciphertext: a 32-byte header plus a body, version in the header", async () => {
    await db.withOrg(b.orgId, (tx) => storeForgeToken(tx, bSecondMemberId, valid, 1));
    await db.withOrg(b.orgId, (tx) =>
      storeForgeToken(tx, bSecondMemberId, fakeCiphertext("x", 7), 7),
    );
    expect(await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, bSecondMemberId))).toEqual({
      ciphertext: fakeCiphertext("x", 7),
      keyVersion: 7,
    });
  });

  it("the minimum length is crypto's: a real empty-body ciphertext is accepted, one byte less is not", async () => {
    expect(MIN_CIPHERTEXT_BYTES).toBe(CRYPTO_MIN_CIPHERTEXT_BYTES);
    const ringB = await openStoredKeyring(b.orgId);
    try {
      const empty = ringB.encrypt("", { purpose: "github_token", recordId: bSecondMemberId });
      const payload = Buffer.from(empty.slice(CIPHERTEXT_PREFIX.length), "base64url");
      expect(payload.length).toBe(MIN_CIPHERTEXT_BYTES);
      await db.withOrg(b.orgId, (tx) => storeForgeToken(tx, bSecondMemberId, empty, 1));
      const short = CIPHERTEXT_PREFIX + payload.subarray(0, -1).toString("base64url");
      await expect(
        db.withOrg(b.orgId, (tx) => storeForgeToken(tx, bSecondMemberId, short, 1)),
      ).rejects.toThrow("secrets: expected a record ciphertext");
    } finally {
      ringB.destroy();
    }
  });

  it.each<[string, string, number]>([
    ["plaintext", SECRETS.userToken, 1],
    ["empty", "", 1],
    ["prefix only", CIPHERTEXT_PREFIX, 1],
    ["bad alphabet", CIPHERTEXT_PREFIX + "not base64url!" + "A".repeat(40), 1],
    ["too short (31 bytes)", CIPHERTEXT_PREFIX + Buffer.alloc(31).toString("base64url"), 1],
    // 34 bytes leave 4 unused bits in the last character; a non-zero value there is refused.
    ["non-canonical base64url", fakeCiphertext(Buffer.alloc(2)).slice(0, -1) + "B", 1],
    ["header version 2, column version 1", fakeCiphertext("x", 2), 1],
    ["wrapped key as record ciphertext", fakeWrappedKey(), 1],
    ["version 0", valid, 0],
    ["version -1", valid, -1],
    ["version 1.5", valid, 1.5],
    ["version NaN", valid, Number.NaN],
    ["version beyond integer", fakeCiphertext("x", 2 ** 31), 2 ** 31],
  ])("rejects %s", async (_, ciphertext, version) => {
    const beforeToken = await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, bSecondMemberId));
    const errors = [
      await caught(
        db.withOrg(b.orgId, (tx) => storeForgeToken(tx, bSecondMemberId, ciphertext, version)),
      ),
      await caught(db.withOrg(b.orgId, (tx) => storeOrgLlmApiKey(tx, ciphertext, version))),
    ];
    for (const error of errors) {
      expect(error).toBeInstanceOf(SecretStoreError);
      expect((error as Error).message).toMatch(
        /^secrets: (expected a record ciphertext|key version)/,
      );
      expect(inspect(error)).not.toContain(SECRETS.userToken);
    }
    expect(await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, bSecondMemberId))).toEqual(
      beforeToken,
    );
  });

  it.each<[string, string, number]>([
    ["plaintext", SECRETS.byokKey, 1],
    ["empty", "", 1],
    ["prefix only", WRAPPED_KEY_PREFIX, 1],
    ["record ciphertext as wrapped key", valid, 1],
    ["version field 2, column version 1", fakeWrappedKey(2), 1],
    ["blob shorter than a 256-bit key", fakeWrappedKey(1, Buffer.alloc(31, 9)), 1],
    ["non-canonical blob", fakeWrappedKey(1, Buffer.alloc(61)).slice(0, -1) + "B", 1],
    ["bad KEK id", `${WRAPPED_KEY_PREFIX}1:v 1:${Buffer.alloc(60).toString("base64url")}`, 1],
    ["version 0", fakeWrappedKey(1), 0],
  ])("rejects a wrapped key that is %s", async (_, wrapped, version) => {
    const error = await caught(db.withOrg(c.orgId, (tx) => storeOrgDataKey(tx, wrapped, version)));
    expect(error).toBeInstanceOf(SecretStoreError);
    expect((error as Error).message).toMatch(/^secrets: (expected a wrapped data key|key version)/);
    expect(inspect(error)).not.toContain(SECRETS.byokKey);
    expect(await db.withOrg(c.orgId, (tx) => loadOrgDataKey(tx))).toBeNull();
  });
});

describe("the org data key is written once, then only by compare-and-swap (review #2)", () => {
  it("stores the first key and refuses a second store", async () => {
    await db.withOrg(c.orgId, (tx) => storeOrgDataKey(tx, fakeWrappedKey(1), 1));
    const error = await caught(
      db.withOrg(c.orgId, (tx) => storeOrgDataKey(tx, fakeWrappedKey(1, Buffer.alloc(60, 1)), 1)),
    );
    expect(error).toBeInstanceOf(SecretStoreError);
    expect((error as Error).message).toBe("secrets: data key already provisioned");
    expect(await db.withOrg(c.orgId, (tx) => loadOrgDataKey(tx))).toEqual({
      ciphertext: fakeWrappedKey(1),
      keyVersion: 1,
    });
  });

  it("replaces only when the expected current version matches", async () => {
    const error = await caught(
      db.withOrg(c.orgId, (tx) => replaceOrgDataKey(tx, fakeWrappedKey(2), 2, 5)),
    );
    expect(error).toBeInstanceOf(SecretStoreError);
    expect((error as Error).message).toBe("secrets: data key version mismatch");
    expect(await db.withOrg(c.orgId, (tx) => loadOrgDataKey(tx))).toMatchObject({ keyVersion: 1 });

    await db.withOrg(c.orgId, (tx) => replaceOrgDataKey(tx, fakeWrappedKey(2), 2, 1));
    expect(await db.withOrg(c.orgId, (tx) => loadOrgDataKey(tx))).toEqual({
      ciphertext: fakeWrappedKey(2),
      keyVersion: 2,
    });
    // A KEK re-wrap keeps the version: same expected and new version is allowed.
    await db.withOrg(c.orgId, (tx) =>
      replaceOrgDataKey(tx, fakeWrappedKey(2, Buffer.alloc(60, 3)), 2, 2),
    );
    expect(await db.withOrg(c.orgId, (tx) => loadOrgDataKey(tx))).toEqual({
      ciphertext: fakeWrappedKey(2, Buffer.alloc(60, 3)),
      keyVersion: 2,
    });
  });

  it("cannot replace a key that was never provisioned", async () => {
    const error = await caught(
      db.withOrg(d.orgId, (tx) => replaceOrgDataKey(tx, fakeWrappedKey(1), 1, 1)),
    );
    expect((error as Error).message).toBe("secrets: data key version mismatch");
    expect(await db.withOrg(d.orgId, (tx) => loadOrgDataKey(tx))).toBeNull();
  });
});

describe("no plaintext reaches an error (review #3)", () => {
  const valid = fakeCiphertext("x");

  it("validates the member id as a uuid before any SQL, with a fixed message", async () => {
    // Arguments swapped: the token lands in the member-id position.
    for (const fn of [
      () => db.withOrg(a.orgId, (tx) => storeForgeToken(tx, SECRETS.userToken, valid, 1)),
      () => db.withOrg(a.orgId, (tx) => loadForgeToken(tx, SECRETS.userToken)),
      () => db.withOrg(a.orgId, (tx) => storeForgeToken(tx, valid, a.memberId, 1)),
    ]) {
      const error = await caught(fn());
      expect(error).toBeInstanceOf(SecretStoreError);
      expect((error as Error).message).toMatch(
        /^secrets: (member id must be a uuid|expected a record ciphertext)/,
      );
      expect((error as Error).cause).toBeUndefined();
      const text = inspect(error, { depth: 10 }) + JSON.stringify(error) + String(error);
      expect(text).not.toContain(SECRETS.userToken);
      expect(text).not.toContain(valid);
      expect(text).not.toContain(a.memberId);
    }
  });

  it("rethrows a database error with a fixed message and only its SQLSTATE", async () => {
    // A tx double whose query rejects the way node-pg + drizzle would for a bad parameter,
    // with the parameter values in the message, as the real driver does.
    const dbError = Object.assign(
      new Error(`invalid input syntax for type uuid: "${SECRETS.userToken}"`),
      { code: "22P02", detail: SECRETS.userToken },
    );
    const driverError = Object.assign(
      new Error(`Failed query: update ... params: ${valid},${SECRETS.userToken}`),
      { cause: dbError },
    );
    const chain = { returning: () => Promise.reject(driverError) };
    const tx = {
      orgId: a.orgId,
      db: { update: () => ({ set: () => ({ where: () => chain }) }) },
    } as unknown as TenantTx;
    const error = await caught(storeForgeToken(tx, a.memberId, valid, 1));
    expect(error).toBeInstanceOf(SecretStoreError);
    expect((error as SecretStoreError).message).toBe("secrets: database error");
    expect((error as SecretStoreError).code).toBe("22P02");
    expect((error as Error).cause).toBeUndefined();
    const text = inspect(error, { depth: 10 }) + JSON.stringify(error) + String(error);
    expect(text).not.toContain(SECRETS.userToken);
    expect(text).not.toContain(valid);
  });

  it("lets a TenantContextError through unchanged (it carries no values)", async () => {
    let saved: TenantTx | undefined;
    await db.withOrg(a.orgId, async (tx) => {
      saved = tx;
    });
    await expect(loadForgeToken(saved!, a.memberId)).rejects.toBeInstanceOf(TenantContextError);
  });
});

describe("positive controls: the dump search does find plaintext", () => {
  const FIXTURE = "public.leak_fixture";
  /** The positive-control rows are removed afterwards so the production tables are clean. */
  const dMemberToken = SECRETS.userToken;
  const dLlmKey = SECRETS.byokKey;

  afterAll(async () => {
    await superuser.query(`drop table if exists ${FIXTURE}`);
  });

  it("an identity-wrapped data key stored through storeOrgDataKey is detected (MAJOR)", async () => {
    const dek = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 53 + 17) & 0xff));
    // What a broken KeyWrapper would store: the raw key as the "blob".
    const wrapped = encodeWrappedDataKey({ version: 1, kekVersion: KEK_VERSION, blob: dek });
    await db.withOrg(d.orgId, (tx) => storeOrgDataKey(tx, wrapped, 1));
    for (const [, options] of DUMP_FORMS) {
      const dump = await pgs.dump(options);
      // Hex bytea: only the decoded payload shows it. Escape bytea: the rkw1: text is verbatim.
      const expected = options.byteaOutput === "escape" ? "base64url" : "decoded";
      expect(findKeyMaterial(dump, [kek, dek])).toEqual([{ index: 1, encoding: expected }]);
      expect(() => assertNoKeyMaterial(dump, [dek])).toThrow("key material found in dump: #0");
    }
  });

  it("a rk1: value whose payload is the plaintext is detected in orgs and members (MAJOR)", async () => {
    await db.withOrg(d.orgId, async (tx) => {
      await storeForgeToken(tx, d.memberId, fakeCiphertext(dMemberToken), 1);
      await storeOrgLlmApiKey(tx, fakeCiphertext(dLlmKey), 1);
    });
    for (const [, options] of DUMP_FORMS) {
      const dump = await pgs.dump(options);
      // Hex bytea: only the decoded payload shows it. Escape bytea: the rk1: text is verbatim
      // and the body sits on a base64 boundary after the 32-byte header.
      const expected = options.byteaOutput === "escape" ? "base64" : "decoded";
      expect(findPlaintextLeaks(dump, SECRET_LIST)).toEqual([
        { index: index("userToken"), encoding: expected },
        { index: index("byokKey"), encoding: expected },
      ]);
      expect(() => assertNoPlaintextLeaks(dump, SECRET_LIST)).toThrow(
        /plaintext secrets found in dump: #\d \(/,
      );
    }
  });

  it.each(DUMP_FORMS)("finds text, bytea and base64 plaintext in a %s dump", async (_, options) => {
    await superuser.query(
      `create table if not exists ${FIXTURE} (id int primary key, t text, b bytea, b64 text)`,
    );
    // Org D still holds the two planted rk1: values; they are reported too.
    const planted = [index("userToken"), index("byokKey")];
    const report = async (): Promise<Record<number, string>> => {
      const dump = await pgs.dump(options);
      return Object.fromEntries(
        findPlaintextLeaks(dump, SECRET_LIST).map((l) => [l.index, l.encoding]),
      );
    };
    const expectAll = (found: Record<number, string>, encoding: string): void => {
      for (const [i] of SECRET_LIST.entries()) {
        if (planted.includes(i)) expect(found[i], `#${i}`).toBeDefined();
        else expect(found[i], `#${i}`).toBe(encoding);
      }
    };

    try {
      // Text column: UTF-8, with COPY escaping of \n, \t, \b, \f, \v and \, INSERT doubling '.
      for (const [i, secret] of SECRET_LIST.entries()) {
        await superuser.query(`insert into ${FIXTURE} (id, t) values ($1, $2)`, [i, secret]);
      }
      expectAll(await report(), "utf8");
      await expect(
        pgs.dump(options).then((d) => assertNoPlaintextLeaks(d, SECRET_LIST)),
      ).rejects.toThrow(/plaintext secrets found in dump: #0 \(utf8\)/);

      // bytea column: hex, or escape-format octal for the secrets with control characters.
      await superuser.query(`update ${FIXTURE} set t = null, b = convert_to(t, 'UTF8')`);
      const found = await report();
      if (options.byteaOutput === "escape") {
        for (const name of ["installationToken", "userToken", "byokKey"] as const) {
          expect(found[index(name)]).toBe("utf8"); // printable: rendered verbatim
        }
        for (const name of ["privateKey", "awkward", "control"] as const) {
          expect(found[index(name)]).toBe("escape");
        }
      } else {
        expectAll(found, "hex");
      }

      // base64 text (Postgres wraps its base64 at 76 columns; a leaked token would not be).
      await superuser.query(
        `update ${FIXTURE} set b64 = regexp_replace(encode(b, 'base64'), '\\s', '', 'g'), b = null`,
      );
      expectAll(await report(), "base64");
    } finally {
      await superuser.query(`truncate ${FIXTURE}`);
    }
  });

  it("the production tables are clean again once the fixture and the planted rows are gone", async () => {
    await superuser.query(`drop table if exists ${FIXTURE}`);
    await superuser.query(
      `update orgs set data_key_ciphertext = null, data_key_version = null,
                      llm_api_key_ciphertext = null, llm_api_key_version = null where id = $1`,
      [d.orgId],
    );
    await superuser.query(
      `update members set forge_token_ciphertext = null, forge_token_key_version = null where org_id = $1`,
      [d.orgId],
    );
    for (const [, options] of DUMP_FORMS) {
      const dump = await pgs.dump(options);
      assertNoPlaintextLeaks(dump, SECRET_LIST);
      assertNoKeyMaterial(dump, [kek, ...deks.values()]);
    }
  });
});
