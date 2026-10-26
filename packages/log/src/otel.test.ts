import {
  ROOT_CONTEXT,
  TraceFlags,
  context,
  trace,
  type Context,
  type ContextManager,
} from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./index.js";
import { traceContextMixin } from "./otel.js";

/**
 * The smallest possible synchronous context manager: enough to make `context.with` propagate
 * an active span without pulling in the OpenTelemetry SDK.
 */
class StackContextManager implements ContextManager {
  readonly #stack: Context[] = [ROOT_CONTEXT];
  active(): Context {
    return this.#stack[this.#stack.length - 1] ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    this.#stack.push(ctx);
    try {
      return fn.call(thisArg, ...args);
    } finally {
      this.#stack.pop();
    }
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

const spanContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: TraceFlags.SAMPLED,
};

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger("otel", {
    destination: {
      write: (c: string) => void lines.push(JSON.parse(c) as Record<string, unknown>),
    },
  });
  return { log, lines };
};

describe("OpenTelemetry trace context", () => {
  it("is a no-op when nothing is registered (no SDK, no active span)", () => {
    expect(traceContextMixin()).toEqual({});
    const { log, lines } = capture();
    log.info("plain");
    expect(lines[0]).not.toHaveProperty("trace_id");
    expect(lines[0]).not.toHaveProperty("span_id");
  });

  describe("with a context manager", () => {
    beforeAll(() => {
      expect(context.setGlobalContextManager(new StackContextManager())).toBe(true);
    });
    afterAll(() => context.disable());

    it("injects trace_id, span_id and trace_flags while a span is active", () => {
      const { log, lines } = capture();
      const span = trace.wrapSpanContext(spanContext);
      context.with(trace.setSpan(context.active(), span), () => log.info("traced"));
      log.info("after");
      expect(lines[0]).toMatchObject({
        msg: "traced",
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: "01",
      });
      expect(lines[1]).not.toHaveProperty("trace_id");
    });

    it("ignores an invalid span context", () => {
      const span = trace.wrapSpanContext({ ...spanContext, traceId: "0".repeat(32) });
      context.with(trace.setSpan(context.active(), span), () => {
        expect(traceContextMixin()).toEqual({});
      });
    });

    it("does not let log fields override the trace ids", () => {
      const { log, lines } = capture();
      const span = trace.wrapSpanContext(spanContext);
      context.with(trace.setSpan(context.active(), span), () =>
        log.info({ trace_id: "forged", span_id: "forged" }, "x"),
      );
      expect(lines[0]).toMatchObject({
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
      });
    });
  });
});
