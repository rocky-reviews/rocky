// Creates .env from .env.example on first run so `pnpm dev` works on a fresh clone, and adds a
// locally generated key-encryption key (ADR-0006) so envelope encryption works in development.
// Never overwrites an existing .env.
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync } from "node:fs";

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  const kek = randomBytes(32).toString("base64");
  appendFileSync(
    ".env",
    `\n# Generated for this machine only; never commit.\nROCKY_KEK_KEYS=dev=${kek}\n`,
  );
  console.log("created .env from .env.example (local development defaults + dev ROCKY_KEK_KEYS)");
}
