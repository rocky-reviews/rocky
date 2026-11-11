import { closeSync, constants, openSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Logger } from "@rocky-reviews/log";
import { ConfigError } from "./config.js";

/**
 * The worker's liveness signal (P10-1, ADR 0043 S8). The worker has no HTTP port, so a
 * container healthcheck reads a file the event loop must refresh: `ROCKY_HEARTBEAT_FILE` is
 * rewritten with the current time every `HEARTBEAT_INTERVAL_MS` (`deploy/healthcheck/worker.mjs`
 * calls it stale after 60 s). A blocked event loop, a crashed timer or a process that stopped
 * without exiting all stop the writes. Off when the variable is unset (local development).
 *
 * The file is opened without following a symlink (`O_NOFOLLOW`) and owner-only (0600): on the
 * tmpfs the compose file mounts, only the worker's own uid can write there anyway. A failure
 * is logged once per error code, by code only (never the path), and the timer keeps trying.
 */

export const HEARTBEAT_INTERVAL_MS = 10_000;

type Env = Readonly<Record<string, string | undefined>>;

export const heartbeatFileFromEnv = (env: Env): string | undefined => {
  const value = env["ROCKY_HEARTBEAT_FILE"];
  if (value === undefined || value === "") return undefined;
  if (!isAbsolute(value)) {
    throw new ConfigError("ROCKY_HEARTBEAT_FILE must be an absolute path (unset turns it off)");
  }
  return value;
};

export interface Heartbeat {
  stop(): void;
}

export interface HeartbeatOptions {
  readonly file: string;
  readonly log: Logger;
  readonly intervalMs?: number;
}

const beat = (file: string): void => {
  const fd = openSync(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, new Date().toISOString());
  } finally {
    closeSync(fd);
  }
};

export const startHeartbeat = (options: HeartbeatOptions): Heartbeat => {
  let lastCode: string | undefined;
  const tick = (): void => {
    try {
      beat(options.file);
      lastCode = undefined;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const errorCode = typeof code === "string" ? code : "unknown";
      if (errorCode !== lastCode) {
        lastCode = errorCode;
        options.log.warn(
          { errorCode },
          "heartbeat file could not be written (ROCKY_HEARTBEAT_FILE)",
        );
      }
    }
  };
  tick();
  // unref: the heartbeat never keeps a worker alive that has otherwise finished shutting down.
  const timer = setInterval(tick, options.intervalMs ?? HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};
