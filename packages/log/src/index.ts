import { pino, type Logger } from "pino";

/**
 * Field names that must never reach a log line. P2-4 extends this with value-based scrubbing
 * (tokens, emails) and tests; this list is the floor from day one.
 */
export const REDACT_PATHS = [
  "*.token",
  "*.accessToken",
  "*.apiKey",
  "*.password",
  "*.secret",
  "*.authorization",
  "*.email",
  "*.diff",
  "*.patch",
  "*.code",
  "*.prompt",
  "req.headers.authorization",
  "req.headers.cookie",
];

export const createLogger = (name: string): Logger =>
  pino({
    name,
    level: process.env["LOG_LEVEL"] ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  });

export type { Logger };
