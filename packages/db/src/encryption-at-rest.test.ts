import { randomBytes } from "node:crypto";
import {
  CIPHERTEXT_PREFIX as CRYPTO_CIPHERTEXT_PREFIX,
  decodeWrappedDataKey,
  encodeWrappedDataKey,
  isCryptoError,
  LocalKeyWrapper,
  OrgKeyring,
  generateLocalKek,
  type WrappedDataKey,
} from "@rocky-reviews/crypto";
import { assertNoPlaintextLeaks, findPlaintextLeaks } from "@rocky-reviews/crypto/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import * as schema from "./schema.js";
import {
  CIPHERTEXT_PREFIX,
  loadForgeToken,
  loadOrgDataKey,
  loadOrgLlmApiKey,
  storeForgeToken,
  storeOrgDataKey,
  storeOrgLlmApiKey,
  WRAPPED_KEY_PREFIX,
} from "./secrets.js";
import {
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
} from "./testing/index.js";

/**
 * P2-3 acceptance criterion "DB dump contains no plaintext tokens (test greps a dump)".
 *
 * Two orgs get their own data key (DEK), wrapped by a `LocalKeyWrapper` KEK, and realistic fake
 * secrets encrypted under those DEKs are written to the `*_ciphertext` columns of `orgs` and
 * `members` through the `secrets.ts` helpers. A real `pg_dump --format=plain` (COPY and INSERT
 * syntax, which escape text differently) is then searched for every secret, every DEK and the
 * KEK, as UTF-8, COPY-escaped text, hex `bytea` and base64. A positive control writes the same
 * secrets unencrypted into a throwaway table and proves the search finds them, so a passing
 * run is not vacuous. Every fake secret is assembled at runtime so no token-shaped literal
 * exists in the source tree.
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
  /** A tab and a backslash: the two other characters pg_dump's COPY format escapes. */
  awkward: "webhook" + "\t" + chars(20, 31) + "\\" + chars(12, 37),
} as const;
const SECRET_LIST: readonly string[] = Object.values(SECRETS);

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

/** The byte forms a key could take in a text dump: raw, hex (pg_dump bytea) and base64. */
const assertBytesAbsent = (dump: string, bytes: Buffer, label: string): void => {
  expect(Buffer.from(dump, "utf8").includes(bytes), `${label} raw`).toBe(false);
  expect(Buffer.from(dump, "latin1").includes(bytes), `${label} raw (latin1)`).toBe(false);
  const hex = bytes.toString("hex");
  expect(dump.includes(hex) || dump.includes(hex.toUpperCase()), `${label} hex`).toBe(false);
  // Base64 at every alignment: the characters fully determined by the key bytes.
  for (const encoding of ["base64", "base64url"] as const) {
    for (let pad = 0; pad < 3; pad++) {
      const encoded = Buffer.concat([Buffer.alloc(pad), bytes])
        .toString(encoding)
        .replace(/=+$/, "");
      const needle = encoded.slice(pad === 0 ? 0 : pad + 1, encoded.length - 1);
      expect(dump.includes(needle), `${label} ${encoding} (alignment ${pad})`).toBe(false);
    }
  }
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

beforeAll(async () => {
  pgs = await startPostgres();
  superuser = new pg.Pool({ connectionString: pgs.superUrl, max: 2 });
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  kek = Buffer.from(generateLocalKek(), "base64");
  wrapper = new LocalKeyWrapper([[KEK_VERSION, kek]]);
  a = await seedOrg(db, newOrgId());
  b = await seedOrg(db, newOrgId());
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
    } finally {
      ringA.destroy();
      ringB.destroy();
    }
    // Every secret column of both orgs is populated: the dump below has something to leak.
    // (The superuser, because the owner pool is under FORCE RLS and sees no tenant rows.)
    const populated = await superuser.query<{ n: string }>(
      `select (select count(*) from orgs where data_key_ciphertext is not null and llm_api_key_ciphertext is not null)
            + (select count(*) from members where forge_token_ciphertext is not null) as n`,
    );
    expect(populated.rows[0]?.n).toBe("5");
  });

  it.each([
    ["COPY", { inserts: false }],
    ["INSERT", { inserts: true }],
  ])("a plain pg_dump (%s syntax) holds no secret, data key or KEK", async (_, options) => {
    const dump = await pgs.dump(options);
    // Sanity: it is a full dump (about 59 KB here) that does carry the secret columns, as
    // ciphertext.
    expect(dump.length).toBeGreaterThan(20_000);
    expect(dump).toContain("CREATE TABLE public.members");
    expect(dump).toContain(Buffer.from(CIPHERTEXT_PREFIX, "utf8").toString("hex"));
    expect(dump).toContain(Buffer.from(WRAPPED_KEY_PREFIX, "utf8").toString("hex"));

    assertNoPlaintextLeaks(dump, SECRET_LIST);
    assertBytesAbsent(dump, kek, "KEK");
    expect(dump).not.toContain(kek.toString("base64"));
    expect(deks.size).toBe(2);
    for (const [orgId, dek] of deks) assertBytesAbsent(dump, dek, `DEK of ${orgId}`);
  });

  it("decrypts every stored secret back through the stored data keys (round trip)", async () => {
    const ringA = await openStoredKeyring(a.orgId);
    const ringB = await openStoredKeyring(b.orgId);
    try {
      const llmA = await db.withOrg(a.orgId, (tx) => loadOrgLlmApiKey(tx));
      const tokenA = await db.withOrg(a.orgId, (tx) => loadForgeToken(tx, a.memberId));
      const llmB = await db.withOrg(b.orgId, (tx) => loadOrgLlmApiKey(tx));
      const tokenB = await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, b.memberId));
      const tokenB2 = await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, bSecondMemberId));
      expect([llmA, tokenA, llmB, tokenB, tokenB2].every((s) => s?.keyVersion === 1)).toBe(true);

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
      db.withOrg(b.orgId, (tx) => storeForgeToken(tx, a.memberId, CIPHERTEXT_PREFIX + "AAAA", 1)),
    ).rejects.toThrow(/no such member/);
    const after = await db.withOrg(a.orgId, (tx) => loadForgeToken(tx, a.memberId));
    expect(after).toEqual(before);
    expect(await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, a.memberId))).toBeNull();
  });

  it("refuses anything that is not ciphertext before touching the database", async () => {
    const attempts: [string, number][] = [
      [SECRETS.userToken, 1], // plaintext
      ["", 1],
      [CIPHERTEXT_PREFIX, 1], // prefix only
      [CIPHERTEXT_PREFIX + "not base64url!", 1],
      [WRAPPED_KEY_PREFIX + "1:v1:AAAA", 1], // a wrapped key is not a record ciphertext
      [CIPHERTEXT_PREFIX + "AAAA", 0],
      [CIPHERTEXT_PREFIX + "AAAA", -1],
      [CIPHERTEXT_PREFIX + "AAAA", 1.5],
      [CIPHERTEXT_PREFIX + "AAAA", Number.NaN],
      [CIPHERTEXT_PREFIX + "AAAA", 2 ** 31], // beyond integer
    ];
    for (const [ciphertext, version] of attempts) {
      await expect(
        db.withOrg(b.orgId, (tx) => storeForgeToken(tx, bSecondMemberId, ciphertext, version)),
        JSON.stringify([ciphertext.length, version]),
      ).rejects.toThrow(/ciphertext|version/);
      await expect(
        db.withOrg(b.orgId, (tx) => storeOrgLlmApiKey(tx, ciphertext, version)),
      ).rejects.toThrow(/ciphertext|version/);
    }
    // The same for the wrapped key: a record ciphertext is not a wrapped key, nor is plaintext.
    for (const wrapped of [SECRETS.byokKey, CIPHERTEXT_PREFIX + "AAAA", WRAPPED_KEY_PREFIX, ""]) {
      await expect(db.withOrg(b.orgId, (tx) => storeOrgDataKey(tx, wrapped, 1))).rejects.toThrow(
        /wrapped data key/,
      );
    }
    // Nothing above reached the rows.
    const dump = await pgs.dump();
    assertNoPlaintextLeaks(dump, SECRET_LIST);
    expect(await db.withOrg(b.orgId, (tx) => loadForgeToken(tx, bSecondMemberId))).toMatchObject({
      keyVersion: 1,
    });
  });
});

describe("positive control: the dump search does find plaintext", () => {
  const FIXTURE = "public.leak_fixture";

  afterAll(async () => {
    await superuser.query(`drop table if exists ${FIXTURE}`);
  });

  it.each([
    ["COPY", { inserts: false }],
    ["INSERT", { inserts: true }],
  ])("finds text, bytea and base64 plaintext in a %s dump", async (_, options) => {
    await superuser.query(
      `create table if not exists ${FIXTURE} (id int primary key, t text, b bytea, b64 text)`,
    );
    const report = async (): Promise<string[]> => {
      const dump = await pgs.dump(options);
      return findPlaintextLeaks(dump, SECRET_LIST).map((l) => `${l.index}:${l.encoding}`);
    };
    const all = (encoding: string): string[] => SECRET_LIST.map((_, i) => `${i}:${encoding}`);

    try {
      // Text column: UTF-8, with COPY escaping of \n, \t and \ in the COPY dump.
      for (const [i, secret] of SECRET_LIST.entries()) {
        await superuser.query(`insert into ${FIXTURE} (id, t) values ($1, $2)`, [i, secret]);
      }
      expect(await report()).toEqual(all("utf8"));
      expect(() => assertNoPlaintextLeaks("", SECRET_LIST)).not.toThrow();
      await expect(
        pgs.dump(options).then((d) => assertNoPlaintextLeaks(d, SECRET_LIST)),
      ).rejects.toThrow(/plaintext secrets found in dump: #0 \(utf8\)/);

      // bytea column: pg_dump writes it as hex.
      await superuser.query(`update ${FIXTURE} set t = null, b = convert_to(t, 'UTF8')`);
      expect(await report()).toEqual(all("hex"));

      // base64 text (Postgres wraps its base64 at 76 columns; a leaked token would not be).
      await superuser.query(
        `update ${FIXTURE} set b64 = regexp_replace(encode(b, 'base64'), '\\s', '', 'g'), b = null`,
      );
      expect(await report()).toEqual(all("base64"));
    } finally {
      await superuser.query(`truncate ${FIXTURE}`);
    }
  });

  it("the production tables are clean again once the fixture is gone", async () => {
    await superuser.query(`drop table if exists ${FIXTURE}`);
    assertNoPlaintextLeaks(await pgs.dump(), SECRET_LIST);
  });
});
