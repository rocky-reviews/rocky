import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isLlmCallError,
  isLlmEffort,
  isLlmErrorKind,
  isLlmRole,
  isRetryableLlmError,
  LLM_COMPLETION_ROLES,
  LLM_EFFORTS,
  LLM_ERROR_KINDS,
  LLM_FATAL_ERROR_KINDS,
  LLM_RETRYABLE_ERROR_KINDS,
  LLM_ROLES,
  LlmCallError,
} from "./llm.js";

describe("LLM port (P4-1)", () => {
  it("names the five roles, four of them completions", () => {
    expect(LLM_ROLES).toEqual(["triage", "review", "graph", "ask", "embed"]);
    expect(LLM_COMPLETION_ROLES).toEqual(["triage", "review", "graph", "ask"]);
  });

  it("orders the effort scale lowest to highest", () => {
    expect(LLM_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("recognises only known roles and efforts", () => {
    for (const role of LLM_ROLES) expect(isLlmRole(role)).toBe(true);
    for (const effort of LLM_EFFORTS) expect(isLlmEffort(effort)).toBe(true);
    for (const value of ["", "Review", "embedding", "none", 1, null, undefined]) {
      expect(isLlmRole(value), String(value)).toBe(false);
      expect(isLlmEffort(value), String(value)).toBe(false);
    }
  });

  it("names no vendor SDK in core's sources", () => {
    const src = new URL("./", import.meta.url);
    for (const file of readdirSync(src).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    )) {
      const text = readFileSync(new URL(file, src), "utf8");
      expect(text, file).not.toMatch(/@anthropic-ai|openai|@aws-sdk|@google-cloud|@azure/);
    }
  });
});

describe("LlmCallError (review round 1, S4)", () => {
  it("splits kinds into retryable and fatal, with fixed messages", () => {
    expect([...LLM_RETRYABLE_ERROR_KINDS]).toEqual([
      "rate_limited",
      "overloaded",
      "server_error",
      "timeout",
      "network",
    ]);
    expect([...LLM_FATAL_ERROR_KINDS]).toEqual([
      "auth",
      "permission",
      "billing",
      "invalid_request",
      "model_not_found",
      "request_too_large",
      "context_too_long",
      "cancelled",
    ]);
    for (const kind of LLM_ERROR_KINDS) {
      const error = new LlmCallError(kind);
      expect(error.retryable).toBe((LLM_RETRYABLE_ERROR_KINDS as readonly string[]).includes(kind));
      expect(error.message).toBe(new LlmCallError(kind).message);
      expect(error.message.length).toBeGreaterThan(0);
      expect(isLlmCallError(error)).toBe(true);
      expect(isRetryableLlmError(error)).toBe(error.retryable);
    }
  });

  it("carries a retry-after hint and nothing from the provider", () => {
    const error = new LlmCallError("rate_limited", { retryAfterMs: 1500 });
    expect(error.retryAfterMs).toBe(1500);
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error).sort()).toEqual(["kind", "name", "retryAfterMs", "retryable"]);
    expect(new LlmCallError("auth").retryAfterMs).toBeUndefined();
    expect(() => new LlmCallError("timeout", { retryAfterMs: -1 })).toThrow(RangeError);
  });

  it("guards only real LlmCallErrors", () => {
    for (const value of [
      new Error("rate_limited"),
      { name: "LlmCallError", kind: "rate_limited", retryable: true },
      null,
      "x",
    ]) {
      expect(isLlmCallError(value)).toBe(false);
      expect(isRetryableLlmError(value)).toBe(false);
    }
    expect(isLlmErrorKind("network")).toBe(true);
    expect(isLlmErrorKind("teapot")).toBe(false);
  });
});
