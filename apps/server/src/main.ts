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
    process.exit(1);
  }
  throw error;
}

const shutdown = async (): Promise<void> => {
  try {
    await server.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
