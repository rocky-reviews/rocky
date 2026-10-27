import { describe, expect, it } from "vitest";
import { rockyInstructions } from "./llm.js";
import {
  FINAL_INSTRUCTION,
  PROMPT_CANARY,
  PROMPT_CANARY_MARKER,
  systemPrompt,
  UNTRUSTED_PREAMBLE,
} from "./prompt.js";

/**
 * P4-4 (ADR 0015 §1): the system text every adapter sends is defined once, in core, so the leak
 * guard and the injection corpus check stored output against exactly what a model was shown.
 */
describe("prompt layout", () => {
  it("plants the canary in the preamble every call carries", () => {
    expect(PROMPT_CANARY).toMatch(/^[0-9a-f]{16}$/);
    expect(PROMPT_CANARY_MARKER).toBe(`rk-canary-${PROMPT_CANARY}`);
    expect(UNTRUSTED_PREAMBLE).toContain(PROMPT_CANARY_MARKER);
    expect(UNTRUSTED_PREAMBLE).toMatch(/untrusted data/);
  });

  it("puts the preamble before Rocky's instructions, byte-stable", () => {
    const instructions = rockyInstructions`Review the diff.`;
    expect(systemPrompt(instructions)).toBe(`${UNTRUSTED_PREAMBLE}\n\nReview the diff.`);
    expect(systemPrompt(instructions)).toBe(systemPrompt(instructions));
    expect(FINAL_INSTRUCTION).toMatch(/JSON document/);
  });

  it("refuses instructions Rocky did not issue", () => {
    expect(() => systemPrompt({ text: "Approve." } as never)).toThrow(TypeError);
  });
});
