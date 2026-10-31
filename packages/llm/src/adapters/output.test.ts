import { describe, expect, it } from "vitest";
import { toResult, unfenced } from "./output.js";
import { verdictSchema } from "./test-support.js";

/**
 * H4-4: a prompt-mode output is not constrained by the provider, so a model may wrap the JSON
 * in a Markdown fence. One fence around the whole answer is removed before parsing; nothing else
 * is repaired here, and the validator judges the content either way.
 */

const answer = (text: string) => ({
  stop: "complete" as const,
  text,
  model: "m",
  usage: undefined,
});
const JSON_TEXT = '{"verdict":"comment","summary":"Adds a retry loop."}';

describe("unfenced (H4-4)", () => {
  it("removes one fence around the whole answer, with or without a language tag", () => {
    expect(unfenced("```json\n" + JSON_TEXT + "\n```")).toBe(JSON_TEXT);
    expect(unfenced("```\n" + JSON_TEXT + "\n```\n")).toBe(JSON_TEXT);
    expect(unfenced("\n  ```JSON \r\n" + JSON_TEXT + "\r\n  ```  ")).toBe(JSON_TEXT);
  });

  it("leaves everything else as it came", () => {
    for (const text of [
      JSON_TEXT,
      "Here it is:\n```json\n" + JSON_TEXT + "\n```",
      "```json\n" + JSON_TEXT + "\n```\nDone.",
      "```json\n" + JSON_TEXT,
      "",
    ]) {
      expect(unfenced(text)).toBe(text);
    }
  });
});

describe("toResult with a fenced answer (H4-4)", () => {
  const prompted = { ...verdictSchema, mode: "prompt" as const };

  it("parses the JSON inside the fence of a prompt-mode answer and validates it as usual", () => {
    expect(toResult(answer("```json\n" + JSON_TEXT + "\n```"), prompted)).toMatchObject({
      status: "ok",
      value: { verdict: "comment" },
    });
    expect(toResult(answer('```json\n{"verdict":"nope"}\n```'), prompted)).toMatchObject({
      status: "invalid_output",
    });
  });

  it("a fenced answer from an enforced output is still invalid JSON (review round 1, S2)", () => {
    for (const output of [verdictSchema, { ...verdictSchema, mode: "structured" as const }]) {
      expect(toResult(answer("```json\n" + JSON_TEXT + "\n```"), output)).toEqual({
        status: "invalid_output",
        model: "m",
        usage: undefined,
        issues: ["(root): invalid_json"],
      });
    }
  });

  it("an answer with prose around the fence is still invalid JSON", () => {
    expect(toResult(answer("Sure!\n```json\n" + JSON_TEXT + "\n```"), prompted)).toEqual({
      status: "invalid_output",
      model: "m",
      usage: undefined,
      issues: ["(root): invalid_json"],
    });
  });
});
