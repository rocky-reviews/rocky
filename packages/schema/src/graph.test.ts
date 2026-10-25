import { describe, expect, it } from "vitest";
import {
  byteLength,
  FlowMessage,
  jsonDepth,
  jsonHasForbiddenCharacters,
  Payload,
} from "./graph.js";
import { MAX_PAYLOAD_SAMPLE_BYTES, MAX_PAYLOAD_SAMPLE_DEPTH } from "./limits.js";

const side = (sample: unknown, extra: Record<string, unknown> = {}) => ({
  request: { type: "T", sample, ...extra },
});

describe("payload samples", () => {
  it("accepts an object, array, number, boolean or null sample", () => {
    for (const sample of [{ a: 1 }, [1, "two"], 3, true, null])
      expect(Payload.safeParse(side(sample)).success, JSON.stringify(sample)).toBe(true);
  });

  it("rejects a root string: JSON text belongs here as the value it spells", () => {
    const result = Payload.safeParse(side('{"a":1}'));
    expect(result.success).toBe(false);
  });

  it("rejects a sample over the byte cap or the depth cap", () => {
    const big = { text: "x".repeat(MAX_PAYLOAD_SAMPLE_BYTES) };
    expect(Payload.safeParse(side(big)).success).toBe(false);

    let deep: unknown = 1;
    for (let i = 0; i <= MAX_PAYLOAD_SAMPLE_DEPTH; i += 1) deep = [deep];
    expect(Payload.safeParse(side(deep)).success).toBe(false);
    expect(Payload.safeParse(side((deep as unknown[])[0])).success).toBe(true);
  });

  it("rejects control characters anywhere in a sample, keys included", () => {
    expect(Payload.safeParse(side({ a: "x\u0000y" })).success).toBe(false);
    expect(Payload.safeParse(side({ "k\u001b": 1 })).success).toBe(false);
    expect(Payload.safeParse(side([["ok", "x\rb"]])).success).toBe(false);
    expect(Payload.safeParse(side({ a: "line\nbreak\tok" })).success).toBe(true);
  });

  it("needs a sample before a `before`, and at least one side", () => {
    expect(Payload.safeParse({ request: { type: "T", before: { a: 1 } } }).success).toBe(false);
    expect(Payload.safeParse(side({ a: 2 }, { before: { a: 1 } })).success).toBe(true);
    expect(Payload.safeParse({}).success).toBe(false);
    expect(Payload.safeParse({ response: { type: "void" } }).success).toBe(true);
  });

  it("rejects a shape over the byte cap even when under the character cap", () => {
    const shape = "€".repeat(1000); // 1 000 characters, 3 000 bytes
    expect(Payload.safeParse({ request: { type: "T", shape } }).success).toBe(false);
    expect(Payload.safeParse({ request: { type: "T", shape: "a".repeat(2048) } }).success).toBe(
      true,
    );
  });
});

describe("helpers", () => {
  it("byteLength counts UTF-8 bytes", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2);
    expect(byteLength("€")).toBe(3);
    expect(byteLength("😀")).toBe(4);
  });

  it("jsonDepth counts nesting", () => {
    expect(jsonDepth(1)).toBe(0);
    expect(jsonDepth({})).toBe(1);
    expect(jsonDepth({ a: [] })).toBe(2);
    expect(jsonDepth([[{ a: null }]])).toBe(3);
  });

  it("jsonHasForbiddenCharacters walks every string", () => {
    expect(jsonHasForbiddenCharacters({ a: [1, { b: "fine" }] })).toBe(false);
    expect(jsonHasForbiddenCharacters({ a: [1, { b: "x\u0007" }] })).toBe(true);
    expect(jsonHasForbiddenCharacters(null)).toBe(false);
  });
});

describe("flow messages", () => {
  const base = { id: "m", from: "a", to: "b", label: "l", delta: "added" } as const;

  it("ties kind 'self' to from === to", () => {
    expect(FlowMessage.safeParse(base).success).toBe(true);
    expect(FlowMessage.safeParse({ ...base, kind: "self" }).success).toBe(false);
    expect(FlowMessage.safeParse({ ...base, to: "a", kind: "self" }).success).toBe(true);
    expect(FlowMessage.safeParse({ ...base, to: "a" }).success).toBe(false);
  });
});
