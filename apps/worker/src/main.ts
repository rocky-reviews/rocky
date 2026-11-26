import { createLogger } from "@rocky-reviews/log";
import { ConfigError } from "./config.js";
import { startWorker, WorkerStartError } from "./worker.js";

/**
 * The worker process: `startWorker` (the composition root, C-8 ADR 0046 §4) on the process
 * environment with the self-host defaults, exit code 1 on a configuration or login problem, and
 * a clean stop on SIGINT/SIGTERM. Rocky Cloud has its own entry on `startWorker`, with its
 * `Entitlements`.
 */

const log = createLogger("worker");

let worker;
try {
  worker = await startWorker(process.env, log);
} catch (error) {
  // Fail closed: no worker without its own login, or (in production) without app credentials.
  // Messages name variables, roles and checks only, never values.
  if (error instanceof WorkerStartError) {
    log.fatal({ ...error.fields, err: error.message }, error.message);
  } else {
    log.fatal(
      { err: error instanceof ConfigError ? error.message : "invalid configuration" },
      "invalid configuration",
    );
  }
  process.exit(1);
}

let shuttingDown: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  shuttingDown ??= (async () => {
    let code = 0;
    try {
      await worker.close();
    } catch {
      code = 1;
    }
    process.exit(code);
  })();
  return shuttingDown;
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
