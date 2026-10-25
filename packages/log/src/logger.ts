import { pino, type DestinationStream, type LogFn, type Logger, type LoggerOptions } from "pino";
import { traceContextMixin } from "./otel.js";
import { REDACTED, REDACT_PATHS, isErrorCodeIdentifier } from "./redact-paths.js";
import { scrubString, scrubValue } from "./scrub.js";

export interface CreateLoggerOptions {
  /** Defaults to `LOG_LEVEL`, then `info`. */
  readonly level?: string;
  /** Where lines go; tests pass an in-memory sink. Defaults to stdout. */
  readonly destination?: DestinationStream;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const scrubArg = (arg: unknown): unknown => {
  if (typeof arg === "string") return scrubString(arg);
  if (typeof arg === "object" && arg !== null) return scrubValue(arg);
  return arg;
};

/**
 * Runs before pino touches the arguments: deep-scrubs the merging object (sensitive keys at any
 * depth, secrets inside strings, Error instances), scrubs the message and interpolation values.
 * Pino's own `redact` paths then run as a second, independent layer.
 */
function scrubLogMethod(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
  const list: unknown[] = args;
  const [first, ...rest] = list;
  let out: unknown[];
  if (first instanceof Error) {
    const tail = rest.length === 0 ? [first.message] : rest;
    out = [{ err: scrubValue(first) }, ...tail.map(scrubArg)];
  } else if (isPlainObject(first) || Array.isArray(first)) {
    out = [scrubValue(first), ...rest.map(scrubArg)];
  } else {
    out = list.map(scrubArg);
  }
  method.apply(this, out as Parameters<LogFn>);
}

/** Pino `censor`: keep operational error codes under `code`, redact everything else. */
const censor = (value: unknown, path: string[]): unknown =>
  path[path.length - 1] === "code" && isErrorCodeIdentifier(value) ? value : REDACTED;

/**
 * The project logger. Every line is JSON; sensitive keys are redacted, secrets are scrubbed
 * from text, and OpenTelemetry trace ids are attached when a span is active. Children inherit
 * all of it, so `log.child({...})` is always safe.
 */
export const createLogger = (name: string, options: CreateLoggerOptions = {}): Logger => {
  const loggerOptions: LoggerOptions = {
    name,
    level: options.level ?? process.env["LOG_LEVEL"] ?? "info",
    redact: { paths: [...REDACT_PATHS], censor },
    mixin: traceContextMixin,
    // Trace ids come from the active span; a log call cannot forge or override them.
    mixinMergeStrategy: (mergeObject, mixinObject) => Object.assign(mergeObject, mixinObject),
    // Errors are already serialised (and scrubbed) by the hook; pino's default `err`
    // serializer would re-serialise the plain object and relabel its type.
    serializers: { err: (value: unknown) => value },
    hooks: { logMethod: scrubLogMethod },
  };
  return options.destination === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.destination);
};

export type { Logger };
