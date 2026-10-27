import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isLlmEffort, isLlmRole, LLM_COMPLETION_ROLES, LLM_EFFORTS, LLM_ROLES } from "./llm.js";

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
