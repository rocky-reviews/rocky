// Creates .env from .env.example on first run so `pnpm dev` works on a fresh clone.
// Never overwrites an existing .env.
import { copyFileSync, existsSync } from "node:fs";

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  console.log("created .env from .env.example (local development defaults)");
}
