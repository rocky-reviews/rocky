import { createLogger } from "@rocky-reviews/log";
import { ConfigError } from "./config.js";
import { startServer, type RunningServer } from "./server.js";

const log = createLogger("server");

let server: RunningServer;
try {
  server = await startServer(process.env, log);
} catch (error) {
  // Configuration first: a production server without a webhook secret must not start (P3-2).
  if (error instanceof ConfigError) {
    log.fatal({ err: error.message }, "invalid configuration");
  } else {
    // e.g. EADDRINUSE: the code only (messages can carry addresses or connection strings).
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    log.fatal({ errorCode: typeof code === "string" ? code : "unknown" }, "server failed to start");
  }
  process.exit(1);
}
// The app's key is parsed into a KeyObject at boot (H4-1); the PEM is dropped from the
// environment so no child process, diagnostic dump or later `process.env` read sees it (as the
// worker does, ADR 0009 L24).
delete process.env["GITHUB_APP_PRIVATE_KEY"];

// server.close() is idempotent, so a second SIGTERM/SIGINT awaits the same shutdown.
const shutdown = async (): Promise<void> => {
  let code = 0;
  try {
    await server.close();
  } catch {
    code = 1;
  }
  process.exit(code);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
