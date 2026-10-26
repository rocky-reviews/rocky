import {
  pino,
  symbols,
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type LogFn,
  type Logger,
  type LoggerOptions,
} from "pino";
import { traceContextMixin } from "./otel.js";
import { REDACTED, REDACT_PATHS, isErrorCodeIdentifier } from "./redact-paths.js";
import { newScrubBudget, scrubString, scrubValue, setKey, type ScrubBudget } from "./scrub.js";

export interface CreateLoggerOptions {
  /** Defaults to `LOG_LEVEL`, then `info`. */
  readonly level?: string;
  /** Where lines go; tests pass an in-memory sink. Defaults to stdout. */
  readonly destination?: DestinationStream;
}

type Serializer = (value: unknown) => unknown;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const scrubArg = (arg: unknown, budget: ScrubBudget): unknown => {
  if (typeof arg === "string") return scrubString(arg, budget);
  if (typeof arg === "object" && arg !== null) return scrubValue(arg, budget);
  return arg;
};

/**
 * Top-level keys with a pino serializer (Fastify's `req`/`res`) are serialised first, so the
 * class instance the serializer understands becomes plain data that the deep scrub can check.
 * Pino runs the serializer again afterwards; ours are idempotent on their own output.
 */
const applySerializers = (
  merge: Record<string, unknown>,
  serializers: Record<string, Serializer> | undefined,
): Record<string, unknown> => {
  if (serializers === undefined) return merge;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(merge)) {
    const serializer = serializers[key];
    if (typeof serializer === "function" && typeof value === "object" && value !== null) {
      try {
        setKey(out, key, serializer(value));
        continue;
      } catch {
        // fall through: the walker renders the instance opaquely
      }
    }
    setKey(out, key, value); // never `out[key] =`: an own `__proto__` key would replace the prototype
  }
  return out;
};

/**
 * Runs before pino touches the arguments: scrubs the message and interpolation values first
 * (so a huge payload cannot spend the budget the message needs), then deep-scrubs the merging
 * object (sensitive keys at any depth, secrets inside strings and keys, Error and class
 * instances), all against one budget. Pino's own `redact` paths then run as a second,
 * independent layer.
 */
function scrubLogMethod(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
  const budget = newScrubBudget();
  const serializers = (this as unknown as Record<symbol, unknown>)[symbols.serializersSym] as
    Record<string, Serializer> | undefined;
  const list: unknown[] = args;
  const [first, ...rest] = list;
  let out: unknown[];
  if (first instanceof Error) {
    const tail = (rest.length === 0 ? [first.message] : rest).map((a) => scrubArg(a, budget));
    out = [{ err: scrubValue(first, budget) }, ...tail];
  } else if (isPlainObject(first)) {
    const tail = rest.map((a) => scrubArg(a, budget));
    out = [scrubValue(applySerializers(first, serializers), budget), ...tail];
  } else if (typeof first === "object" && first !== null) {
    const tail = rest.map((a) => scrubArg(a, budget));
    out = [scrubValue(first, budget), ...tail];
  } else {
    out = list.map((a) => scrubArg(a, budget));
  }
  method.apply(this, out as Parameters<LogFn>);
}

/** Pino `censor`: keep error-code identifiers under `code`, redact everything else. */
const censor = (value: unknown, path: string[]): unknown =>
  path[path.length - 1] === "code" && isErrorCodeIdentifier(value) ? value : REDACTED;

/**
 * The project logger. Every line is JSON; sensitive keys are redacted, secrets are scrubbed
 * from text, class instances are normalised, and OpenTelemetry trace ids are attached when a
 * span is active. Child bindings go through the same scrub, so `log.child({...})` and
 * `log.setBindings({...})` are always safe.
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
  const logger =
    options.destination === undefined
      ? pino(loggerOptions)
      : pino(loggerOptions, options.destination);
  return withScrubbedBindings(logger);
};

/**
 * Bindings are serialised once, when `child()` or `setBindings()` runs, and pino applies
 * `formatters.bindings` to the root only, so the hook never sees them. Wrapping both methods on
 * the root instance scrubs them first; children are created with `Object.create(parent)`, so
 * grandchildren inherit the wrappers too.
 */
const withScrubbedBindings = (logger: Logger): Logger => {
  type Child = (this: Logger, bindings: Bindings, options?: ChildLoggerOptions) => Logger;
  type SetBindings = (this: Logger, bindings: Bindings) => void;
  const originalChild = logger.child as unknown as Child;
  const originalSetBindings = logger.setBindings as unknown as SetBindings;
  const scrubbedChild: Child = function (bindings, options) {
    return originalChild.call(this, scrubValue(bindings) as Bindings, options);
  };
  const scrubbedSetBindings: SetBindings = function (bindings) {
    originalSetBindings.call(this, scrubValue(bindings) as Bindings);
  };
  (logger as { child: unknown }).child = scrubbedChild;
  (logger as { setBindings: unknown }).setBindings = scrubbedSetBindings;
  return logger;
};

export type { Logger };
