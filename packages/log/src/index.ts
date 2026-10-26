/**
 * Project logger (P2-4): pino with two independent redaction layers (field paths and value
 * scrubbing), request ids and OpenTelemetry trace ids. Logs never contain code, diffs, tokens,
 * emails or prompts. Fastify integration lives in `@rocky-reviews/log/fastify`.
 */
export { createLogger, type CreateLoggerOptions, type Logger } from "./logger.js";
export { traceContextMixin } from "./otel.js";
export {
  ALLOWED_KEYS,
  ALLOWED_KEY_PREFIXES,
  SCRUB_ONLY_KEYS,
  REDACTED,
  REDACT_PATHS,
  SENSITIVE_KEYS,
  SENSITIVE_KEY_RULES,
  isErrorCodeIdentifier,
  isSensitiveKey,
} from "./redact-paths.js";
export { newRequestId, withRequestId } from "./request.js";
export {
  MAX_CHARS_PER_CALL,
  MAX_DEPTH,
  MAX_KEY_LENGTH,
  MAX_NODES,
  MAX_SCAN_LENGTH,
  MAX_STRING_LENGTH,
  scrubSecrets,
  scrubString,
  scrubValue,
} from "./scrub.js";
