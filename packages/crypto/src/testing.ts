/**
 * Test helpers for the "a database dump contains no plaintext secrets" check (P2-3). The
 * integration test that runs `pg_dump --format=plain` lives with the schema (P2-1/P2-2); these
 * functions only search a dump. They report secrets by index, never by value, so a failing test
 * does not print the secret it found.
 */

export type LeakEncoding = "utf8" | "hex" | "base64" | "base64url";

export interface PlaintextLeak {
  /** Position of the secret in the `secrets` argument. */
  readonly index: number;
  readonly encoding: LeakEncoding;
}

const MIN_NEEDLE = 8;

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

const needlesFor = (secret: string, encoding: LeakEncoding): string[] => {
  const bytes = Buffer.from(secret, "utf8");
  switch (encoding) {
    case "utf8":
      return [secret];
    case "hex":
      return [bytes.toString("hex"), bytes.toString("hex").toUpperCase()];
    case "base64":
    case "base64url":
      return base64Needles(bytes, encoding);
  }
};

const ENCODINGS: readonly LeakEncoding[] = ["utf8", "hex", "base64", "base64url"];

/**
 * Searches a plain-text dump for each secret as UTF-8, as pg_dump's hex `bytea` form and as
 * base64/base64url (any alignment). Returns at most one leak per secret.
 */
export const findPlaintextLeaks = (
  dump: string | Uint8Array,
  secrets: readonly string[],
): PlaintextLeak[] => {
  const text = typeof dump === "string" ? dump : Buffer.from(dump).toString("utf8");
  const leaks: PlaintextLeak[] = [];
  secrets.forEach((secret, index) => {
    if (secret.length === 0) return;
    const encoding = ENCODINGS.find((enc) => needlesFor(secret, enc).some((n) => text.includes(n)));
    if (encoding !== undefined) leaks.push({ index, encoding });
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
