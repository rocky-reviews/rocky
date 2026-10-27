import { LlmCallError, type LlmErrorKind } from "@rocky-reviews/core";

/**
 * Provider failures → `LlmCallError` (P4-2, ADR 0013 §4; threat T7). The result carries a kind and,
 * on retryable kinds, a retry-after hint; never a body, header, prompt, key or `cause`. Provider
 * text is read only to tell `context_too_long` from `invalid_request`, then dropped.
 */

/** The provider's way of saying the input cannot fit (no typed signal exists). */
const CONTEXT_TOO_LONG =
  /prompt is too long|context[ _-]?(?:length|window)|maximum context|too many (?:input )?tokens/i;

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

export const kindForStatus = (status: number, message: string | undefined): LlmErrorKind => {
  switch (status) {
    case 400:
      return message !== undefined && CONTEXT_TOO_LONG.test(message)
        ? "context_too_long"
        : "invalid_request";
    case 401:
      return "auth";
    case 402:
      return "billing";
    case 403:
      return "permission";
    case 404:
      return "model_not_found";
    case 408:
      return "timeout";
    case 413:
      return "request_too_large";
    case 429:
      return "rate_limited";
    case 529:
      return "overloaded";
    default:
      return status >= 500 ? "server_error" : "invalid_request";
  }
};

/** Anthropic `error.type` values, for errors that arrive mid-stream without a status. */
const KIND_FOR_TYPE: Readonly<Record<string, LlmErrorKind>> = {
  invalid_request_error: "invalid_request",
  authentication_error: "auth",
  permission_error: "permission",
  billing_error: "billing",
  not_found_error: "model_not_found",
  request_too_large: "request_too_large",
  rate_limit_error: "rate_limited",
  timeout_error: "timeout",
  overloaded_error: "overloaded",
  api_error: "server_error",
};

export const kindForType = (type: string | null | undefined): LlmErrorKind =>
  (type === null || type === undefined ? undefined : KIND_FOR_TYPE[type]) ?? "server_error";

/** `retry-after-ms`, then `retry-after` (seconds or an HTTP date); finite, ≥ 0, capped at 24 h. */
export const retryAfterMs = (headers: Headers | undefined): number | undefined => {
  if (headers === undefined) return undefined;
  const ms = headers.get("retry-after-ms");
  let value = ms === null ? Number.NaN : Number(ms);
  if (!Number.isFinite(value)) {
    const raw = headers.get("retry-after");
    if (raw === null || raw.trim() === "") return undefined;
    const seconds = Number(raw);
    value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  }
  if (!Number.isFinite(value)) return undefined;
  return Math.min(Math.max(0, Math.round(value)), MAX_RETRY_AFTER_MS);
};

export const callError = (kind: LlmErrorKind, headers?: Headers): LlmCallError => {
  const error = new LlmCallError(kind);
  if (!error.retryable) return error;
  const hint = retryAfterMs(headers);
  return hint === undefined ? error : new LlmCallError(kind, { retryAfterMs: hint });
};

/** True when the caller's signal ended the call. */
export const cancelledBy = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
