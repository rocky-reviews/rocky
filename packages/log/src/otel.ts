import { isSpanContextValid, trace } from "@opentelemetry/api";

/**
 * Pino mixin: adds the active OpenTelemetry trace and span ids to every line. `@opentelemetry/api`
 * is only the API; without an SDK (or outside a span) there is no active span and this returns
 * nothing, so the logger behaves exactly as if OpenTelemetry were absent. Field names follow
 * the OpenTelemetry log data model so collectors correlate them without configuration.
 */
export const traceContextMixin = (): Record<string, string> => {
  const span = trace.getActiveSpan();
  if (span === undefined) return {};
  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) return {};
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: spanContext.traceFlags.toString(16).padStart(2, "0"),
  };
};
