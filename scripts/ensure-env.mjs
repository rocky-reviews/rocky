// Creates .env from .env.example on first run so `pnpm dev` works on a fresh clone, and adds a
// locally generated key-encryption key (ADR-0006) so envelope encryption works in development.
// Never overwrites an existing .env.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const kek = randomBytes(32).toString("base64");
const contents = `${readFileSync(".env.example", "utf8")}\n# Generated for this machine only; never commit.\nROCKY_KEK_KEYS=dev=${kek}\n`;
try {
  // "wx": create only if absent, in one step (no check-then-write race); 0600 because it holds a key.
  writeFileSync(".env", contents, { flag: "wx", mode: 0o600 });
  console.log("created .env from .env.example (local development defaults + dev ROCKY_KEK_KEYS)");
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
}
