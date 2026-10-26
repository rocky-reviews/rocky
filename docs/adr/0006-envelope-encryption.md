# ADR 0006 — Envelope encryption for tokens and customer keys

- **Status:** Accepted
- **Date:** 2026-10-25
- **Task:** P2-3

## Context

Rocky stores secrets on behalf of tenants: GitHub user OAuth tokens (used to post reviews as
the user, P3-5), installation-related secrets, and customer LLM keys (BYOK, C-5). A database
dump, a backup in object storage or a read-only SQL injection must not expose them. Keys must
be rotatable without downtime, and self-hosted installs must work with nothing but an
environment variable while Rocky Cloud uses a managed KMS.

## Decision

1. **Envelope encryption, two levels.** Every org has a 256-bit **data key (DEK)**. Records are
   encrypted under the org's DEK. The DEK itself is stored only **wrapped** by a
   **key-encryption key (KEK)**. The KEK never touches the database.
2. **`KeyWrapper` port** (`packages/crypto/src/key-wrapper.ts`): `wrap(dek, {orgId,
dataKeyVersion})` and `unwrap(blob, kekVersion, context)`. `LocalKeyWrapper` implements it
   with AES-256-GCM and KEKs from `ROCKY_KEK_KEYS` (dev and self-host). A KMS adapter
   (AWS KMS / GCP KMS `Encrypt`/`Decrypt` with the same context as EncryptionContext) is a later
   task in the private repo; no cloud SDK lives here. The port is defined in `packages/crypto`,
   not `packages/core`: encryption is infrastructure the adapters (db, forge) use, and the domain
   never sees key material.
3. **AES-256-GCM via `node:crypto` only.** No third-party crypto. A fresh random 96-bit nonce
   for every encryption, 128-bit tag.
4. **AAD binds the context.** AAD = canonical, length-prefixed encoding of
   `[format, dekVersion, orgId, purpose, recordId]`. A ciphertext copied to another org, row or
   purpose (`github_token` vs `byok_key`) fails to decrypt. Wrapped DEKs are bound to
   `[orgId, "data_key", dekVersion]` the same way, so a DEK blob copied to another org fails to
   unwrap.
5. **Versioned, self-describing formats.** Ciphertext: `rk1:<base64url(dekVersion u32 ‖ nonce
‖ tag ‖ body)>`; wrapped DEK: `rkw1:<dekVersion>:<kekVersion>:<base64url blob>`. The format
   name and DEK version are part of the AAD, so a changed header fails authentication rather than
   being reinterpreted. Only canonical base64url is accepted, so every single-character change
   is detected.
6. **Rotation without downtime.**
   - _KEK rotation_: deploy the new KEK next to the old one (`ROCKY_KEK_KEYS=old=…,new=…`,
     `ROCKY_KEK_CURRENT=new`), run `rewrapDataKeys` per org, then drop the old KEK. Ciphertexts
     are untouched; both KEKs unwrap while the rotation runs.
   - _DEK rotation_: `rotateDataKey` appends a new DEK version; keyrings encrypt under the newest
     version and decrypt under every version they hold; `OrgKeyring.reencrypt` moves rows at
     any pace; the old version is dropped from the stored set when no row uses it.
7. **Typed, silent errors.** Every failure is a `CryptoError` with a stable `code`
   (`authentication_failed`, `malformed_ciphertext`, `unsupported_format`,
   `unknown_key_version`, `invalid_key`, `invalid_context`, `keyring_destroyed`) and a fixed
   message. No key material, plaintext, ciphertext or context is ever attached.
8. **Key material lifetime.** DEKs are unwrapped into an `OrgKeyring` for one request or job
   and zeroed by `destroy()`; `LocalKeyWrapper` copies the KEK bytes it is given (the caller's
   buffers are never shared or zeroed) and zeroes its copies on `destroy()`; the plaintext chunks
   the cipher produces inside `open()` are zeroed once concatenated, and plaintext buffers
   created internally (re-encryption, `decryptToString`) are zeroed after use. This is best
   effort: V8 may keep copies, so the real boundary is the process.
9. **Key hygiene.** A KEK must decode to exactly 32 bytes **and** look random (at least 16
   distinct byte values; a real key has about 28, the chance of a false reject is below 1e-10),
   so placeholders like 32 zero bytes or an ASCII string are refused. KEK ids are parsed in
   listed order into a `Map` (so `10=…,9=…` makes `9` current and `toString` is an ordinary id),
   and wrapped-key versions are bounded to u32 on decode as well as on encode.

## Threat model

| What can go wrong                                                         | How it is prevented                                                                                                                              | How it is tested                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| DB dump, backup or SQLi reveals tokens                                    | Only ciphertext and wrapped DEKs are stored; the KEK is outside the database                                                                     | `testing.ts` dump-grep helper (utf8 incl. pg_dump COPY escaping, hex, base64 at every alignment); schema-level test is a P2-1 follow-up |
| Tenant A's ciphertext is copied into tenant B's row (cross-tenant replay) | AAD includes org id; wrapped DEK is bound to org id                                                                                              | `keyring.test.ts` "moved to another org", "wrapped key that belongs to another org"                                                     |
| A ciphertext is moved to another row or used for another purpose          | AAD includes record id and purpose                                                                                                               | `keyring.test.ts` "another record or purpose"; property test over random contexts                                                       |
| Tampering with ciphertext, tag, nonce, version or AAD                     | GCM authentication; header inside AAD; canonical base64url only                                                                                  | `aead.test.ts` flips every byte of each part; `property.test.ts` random char and byte mutations                                         |
| Nonce reuse (catastrophic for GCM)                                        | `randomBytes(12)` per call; a DEK encrypts one org's secrets (low volume, far below 2^32 messages)                                               | "fresh random nonce" tests; DEK rotation available if volume ever grows                                                                 |
| Key compromise with no way to rotate                                      | KEK re-wrap and DEK re-encrypt paths; old and new versions coexist                                                                               | "KEK rotation" and "data-key rotation" suites, including retiring old versions                                                          |
| Downgrade or confusion between formats                                    | Explicit format tag in text and in AAD; unknown format → `unsupported_format`                                                                    | `keyring.test.ts` malformed/unsupported table                                                                                           |
| Key material or plaintext leaking through error messages or logs          | Fixed error messages; `CryptoError` carries only `code`; `packages/log` scrubbing as a second layer                                              | "never includes … in the error" tests for aead, wrapper and keyring                                                                     |
| Weak or misconfigured keys (wrong length, bad base64, duplicate ids)      | `assertStrongKey` (32 bytes, ≥ 16 distinct byte values), strict base64 parsing, ordered `Map` of unique ids, explicit current version must exist | `key-wrapper.test.ts` constructor and env table; `hardening.test.ts` F2 (weak keys), F3 (ordering, prototype names)                     |
| Key material lingering after use                                          | `destroy()` zeroes DEKs and the wrapper's own KEK copies; cipher output chunks and internal plaintext buffers zeroed                             | zeroing tests with a spying `KeyWrapper` double; `hardening.test.ts` F1 (chunks), F4 (caller buffers copied)                            |
| Homemade cryptography                                                     | Only `node:crypto` AES-256-GCM; no custom modes, KDFs or padding                                                                                 | Code review; ESLint allows no crypto libraries in the package                                                                           |

## Consequences

- `packages/db` stores `orgs.wrapped_data_keys` (text[] of `rkw1:` strings) and ciphertext
  columns as text with the `rk1:` prefix; a column check `value LIKE 'rk1:%'` is cheap.
- Every decrypt needs the record id and purpose at hand; APIs that return rows must carry them.
- Opening a keyring costs one `unwrap` per DEK version (one KMS call each in production); cache
  keyrings per request/job, never across tenants.
- Follow-ups: KMS adapter (private repo); dump-grep integration test once P2-1 lands; retiring
  DEK versions needs a "no row still uses version n" query in `packages/db`.
