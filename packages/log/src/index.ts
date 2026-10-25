/**
 * Project logger (P2-4): pino with two independent redaction layers (field paths and value
 * scrubbing), request ids and OpenTelemetry trace ids. Logs never contain code, diffs, tokens,
 * emails or prompts. Fastify integration lives in `@rocky-reviews/log/fastify`.
 */
export { createLogger, type CreateLoggerOptions, type Logger } from "./logger.js";
export { traceContextMixin } from "./otel.js";
export {
  REDACTED,
  REDACT_PATHS,
  SENSITIVE_KEYS,
  isErrorCodeIdentifier,
  isSensitiveKey,
} from "./redact-paths.js";
export { newRequestId, withRequestId } from "./request.js";
export {
  MAX_DEPTH,
  MAX_NODES,
  MAX_SCAN_LENGTH,
  MAX_STRING_LENGTH,
  scrubSecrets,
  scrubString,
  scrubValue,
} from "./scrub.js";
