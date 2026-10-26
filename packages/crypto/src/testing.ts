/**
 * Test helpers for the "a database dump contains no plaintext secrets" check (P2-3). The
 * integration test that runs `pg_dump --format=plain` lives with the schema
 * (`packages/db/src/encryption-at-rest.test.ts`); these functions only search a dump. They
 * report secrets by index, never by value, so a failing test does not print the secret it
 * found.
 *
 * A plain dump hides content behind encodings, so every search also runs over the decoded
 * content (`expandDump`): every `bytea` hex literal (COPY `\\x…`, INSERT `'\x…'`) hex-decoded,
 * plus the base64url payload of every `rk1:` / `rkw1:` value found in the dump or in a decoded
 * literal. Without that step a "ciphertext" whose payload is the plaintext, or a data key
 * "wrapped" by an identity wrapper, stored in a bytea column, would pass unseen (review).
 */

/** Where a secret was found; `decoded` = only after decoding a bytea literal or a payload. */
export type LeakEncoding = "utf8" | "escape" | "hex" | "base64" | "base64url" | "decoded";

export interface PlaintextLeak {
  /** Position of the secret in the `secrets` argument. */
  readonly index: number;
  readonly encoding: LeakEncoding;
}

export type KeyEncoding = "raw" | "hex" | "base64" | "base64url" | "decoded";

export interface KeyLeak {
  /** Position of the key in the `keys` argument. */
  readonly index: number;
  readonly encoding: KeyEncoding;
}

const MIN_NEEDLE = 8;
const NEWLINE = Buffer.from("\n");

const toText = (dump: string | Uint8Array): string =>
  typeof dump === "string" ? dump : Buffer.from(dump).toString("utf8");

/**
 * The base64 characters fully determined by `secret` when it starts at each of the three
 * possible byte alignments inside a larger base64 stream.
 */
const base64Needles = (secret: Buffer, encoding: "base64" | "base64url"): string[] => {
  const needles: string[] = [];
  for (let pad = 0; pad < 3; pad++) {
    const encoded = Buffer.concat([Buffer.alloc(pad), secret])
      .toString(encoding)
      .replace(/=+$/, "");
    const start = pad === 0 ? 0 : pad + 1;
    const end = ((pad + secret.length) * 8) % 6 === 0 ? encoded.length : encoded.length - 1;
    const needle = encoded.slice(start, end);
    if (needle.length >= MIN_NEEDLE) needles.push(needle);
  }
  return needles;
};

/** pg_dump's COPY text format escapes backslash and the control characters \b \f \n \r \t \v. */
const COPY_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\v": "\\v",
};
const copyEscape = (text: string): string =>
  text.replace(/[\\\b\f\n\r\t\v]/g, (c) => COPY_ESCAPES[c] ?? c);

/** `--inserts` writes SQL string literals: a single quote is doubled. */
const sqlQuote = (text: string): string => text.replace(/'/g, "''");

/**
 * `bytea_output = escape`: printable ASCII as is, backslash doubled, every other byte as
 * `\ooo` octal. pg_dump honours the session setting, so a dump may hold either form.
 */
const byteaEscape = (bytes: Buffer): string => {
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x5c) out += "\\\\";
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte);
    else out += "\\" + byte.toString(8).padStart(3, "0");
  }
  return out;
};

/** The COPY and INSERT renderings of a text value. */
const textForms = (text: string): string[] => [text, copyEscape(text), sqlQuote(text)];

const needlesFor = (secret: string, encoding: Exclude<LeakEncoding, "decoded">): string[] => {
  const bytes = Buffer.from(secret, "utf8");
  switch (encoding) {
    case "utf8":
      return [...new Set(textForms(secret))];
    case "escape":
      return [...new Set(textForms(byteaEscape(bytes)))];
    case "hex":
      return [bytes.toString("hex"), bytes.toString("hex").toUpperCase()];
    case "base64":
    case "base64url":
      return base64Needles(bytes, encoding);
  }
};

const ENCODINGS: readonly Exclude<LeakEncoding, "decoded">[] = [
  "utf8",
  "escape",
  "hex",
  "base64",
  "base64url",
];

/** A bytea hex literal: `\\x…` in a COPY block, `'\x…'` in an INSERT statement. */
const HEX_LITERAL = /\\x([0-9a-fA-F]{2,})/g;
/** The base64url payloads of the self-describing formats (ADR 0006 §5). */
const RECORD_PAYLOAD = /\brk1:([A-Za-z0-9_-]+)/g;
const WRAPPED_PAYLOAD = /\brkw1:[0-9]+:[A-Za-z0-9_-]+:([A-Za-z0-9_-]+)/g;

const decodeHexLiterals = (text: string): Buffer[] =>
  [...text.matchAll(HEX_LITERAL)].map((m) => Buffer.from(m[1] ?? "", "hex"));

const decodePayloads = (text: string): Buffer[] =>
  [RECORD_PAYLOAD, WRAPPED_PAYLOAD].flatMap((pattern) =>
    [...text.matchAll(pattern)].map((m) => Buffer.from(m[1] ?? "", "base64url")),
  );

/**
 * Everything a dump hides behind an encoding: each bytea hex literal decoded, and the payload
 * of each `rk1:` / `rkw1:` value (in the dump text or inside a decoded literal)
 * base64url-decoded.
 */
const decodedParts = (text: string): Buffer[] => {
  const literals = decodeHexLiterals(text);
  const decodedText = literals.map((bytes) => bytes.toString("utf8"));
  const payloads = [text, ...decodedText].flatMap(decodePayloads);
  return [...literals, ...payloads];
};

const joinParts = (parts: readonly Buffer[]): Buffer =>
  Buffer.concat(parts.flatMap((part) => [part, NEWLINE]));

/**
 * The dump plus everything it encodes (see `decodedParts`), newline-separated. Exposed so a
 * test can see what the searches below look at.
 */
export const expandDump = (dump: string | Uint8Array): Buffer => {
  const text = toText(dump);
  return joinParts([Buffer.from(text, "utf8"), ...decodedParts(text)]);
};

const secretIn = (text: string, secret: string): LeakEncoding | undefined =>
  ENCODINGS.find((enc) => needlesFor(secret, enc).some((n) => text.includes(n)));

/**
 * Searches a plain-text dump for each secret as UTF-8 (COPY-escaped and SQL-quoted forms
 * included), as escape-format bytea, as hex bytea and as base64/base64url (any alignment).
 * What the dump itself does not show is then searched for, in every encoding, in the decoded
 * parts (bytea literals, `rk1:`/`rkw1:` payloads); a hit there is reported as `decoded`.
 * Returns at most one leak per secret.
 */
export const findPlaintextLeaks = (
  dump: string | Uint8Array,
  secrets: readonly string[],
): PlaintextLeak[] => {
  const text = toText(dump);
  const decoded = joinParts(decodedParts(text)).toString("utf8");
  const leaks: PlaintextLeak[] = [];
  secrets.forEach((secret, index) => {
    if (secret.length === 0) return;
    const direct = secretIn(text, secret);
    if (direct !== undefined) leaks.push({ index, encoding: direct });
    else if (secretIn(decoded, secret) !== undefined) leaks.push({ index, encoding: "decoded" });
  });
  return leaks;
};

/** Throws when any secret appears in the dump; the message names secrets by index only. */
export const assertNoPlaintextLeaks = (
  dump: string | Uint8Array,
  secrets: readonly string[],
): void => {
  const leaks = findPlaintextLeaks(dump, secrets);
  if (leaks.length > 0) {
    const list = leaks.map((l) => `#${l.index} (${l.encoding})`).join(", ");
    throw new Error(`plaintext secrets found in dump: ${list}`);
  }
};

const KEY_ENCODINGS: readonly Exclude<KeyEncoding, "decoded">[] = [
  "raw",
  "hex",
  "base64",
  "base64url",
];

/** `bytes` is searched for raw key bytes; `text` (its latin1 view) for the text encodings. */
const keyIn = (bytes: readonly Buffer[], key: Buffer): KeyEncoding | undefined =>
  KEY_ENCODINGS.find((encoding) =>
    bytes.some((buffer) => {
      if (encoding === "raw") return buffer.includes(key);
      const text = buffer.toString("latin1");
      if (encoding === "hex") {
        const hex = key.toString("hex");
        return text.includes(hex) || text.includes(hex.toUpperCase());
      }
      return base64Needles(key, encoding).some((n) => text.includes(n));
    }),
  );

/**
 * Searches a dump for key material (a DEK, a KEK): the raw bytes, hex, and base64/base64url
 * at any alignment, in the dump itself and then in its decoded parts, so a key "wrapped" by an
 * identity wrapper and stored as `rkw1:…:<base64url(key)>` inside a bytea literal is found
 * (reported as `decoded`). Returns at most one leak per key.
 */
export const findKeyMaterial = (
  dump: string | Uint8Array,
  keys: readonly Uint8Array[],
): KeyLeak[] => {
  // A text dump is looked at as UTF-8 and as latin1 bytes; a binary dump as it is.
  const direct =
    typeof dump === "string"
      ? [Buffer.from(dump, "utf8"), Buffer.from(dump, "latin1")]
      : [Buffer.from(dump)];
  const decoded = [joinParts(decodedParts(toText(dump)))];
  const leaks: KeyLeak[] = [];
  keys.forEach((bytes, index) => {
    const key = Buffer.from(bytes);
    if (key.length === 0) return;
    const encoding: KeyEncoding | undefined =
      keyIn(direct, key) ?? (keyIn(decoded, key) === undefined ? undefined : "decoded");
    if (encoding !== undefined) leaks.push({ index, encoding });
  });
  return leaks;
};

/** Throws when any key appears in the dump; the message names keys by index only. */
export const assertNoKeyMaterial = (
  dump: string | Uint8Array,
  keys: readonly Uint8Array[],
): void => {
  const leaks = findKeyMaterial(dump, keys);
  if (leaks.length > 0) {
    const list = leaks.map((l) => `#${l.index} (${l.encoding})`).join(", ");
    throw new Error(`key material found in dump: ${list}`);
  }
};
