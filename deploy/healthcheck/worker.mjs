// The worker image's HEALTHCHECK (P10-1, ADR 0043 S8): the worker rewrites ROCKY_HEARTBEAT_FILE
// every 10 s while its lanes run (apps/worker/src/heartbeat.ts). Healthy (exit 0) when the file
// was touched within the last 60 s; exit 1 when it is older, missing or not configured. Prints
// nothing.
import { statSync } from "node:fs";

const STALE_MS = 60_000;
const file = process.env["ROCKY_HEARTBEAT_FILE"];
if (file === undefined || file === "") process.exit(1);
try {
  const { mtimeMs } = statSync(file);
  process.exit(Date.now() - mtimeMs <= STALE_MS ? 0 : 1);
} catch {
  process.exit(1);
}
