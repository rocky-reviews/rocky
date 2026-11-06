import { describe, expect, it } from "vitest";
import { MemoryListResponse, parseMemoryEdit, parseMemorySwitch } from "./memory-api.js";

/** P8-3 (ADR 0039 §2): the memory page's wire format and the requests the server reads. */

const SHA = "c".repeat(40);
const view = (patch: Record<string, unknown> = {}) => ({
  id: "6f1c2b9e-3a4d-4c5e-8f70-1a2b3c4d5e6f",
  kind: "dismissal",
  origin: "learned",
  text: "Dismissed as intentional: a swallowed error",
  reason: "intentional",
  severity: "high",
  evidence: { path: "src/a.ts", sha: SHA, range: { start: 1, end: 4 }, pullRequestNumber: 12 },
  confidence: 80,
  author: { kind: "member", login: "alice" },
  createdAt: "2026-11-01T10:00:00.000Z",
  lastUsedAt: null,
  supersededBy: null,
  disabledAt: null,
  ...patch,
});
const response = (entries: unknown[]) => ({
  repository: { owner: "acme", name: "api", memoryEnabled: true },
  canEdit: false,
  entries,
  truncated: false,
});

describe("MemoryListResponse", () => {
  it("accepts a valid answer, including a former member", () => {
    expect(
      MemoryListResponse.safeParse(
        response([
          view(),
          view({ id: "7f1c2b9e-3a4d-4c5e-8f70-1a2b3c4d5e6f", author: { kind: "former_member" } }),
        ]),
      ).success,
    ).toBe(true);
  });

  it("refuses multi-line text, a bad path, an author with an id, extra fields and duplicates", () => {
    for (const bad of [
      view({ text: "two\nlines" }),
      view({ evidence: { ...view().evidence, path: "../etc/passwd" } }),
      view({ author: { kind: "member", login: "alice", memberId: "x" } }),
      view({ author: { kind: "former_member", login: "alice" } }),
      view({ extra: true }),
      view({ confidence: 101 }),
      view({ evidence: { ...view().evidence, range: { start: 5, end: 4 } } }),
    ]) {
      expect(MemoryListResponse.safeParse(response([bad])).success).toBe(false);
    }
    expect(MemoryListResponse.safeParse(response([view(), view()])).success).toBe(false);
  });
});

describe("parseMemoryEdit", () => {
  it("reads kind, text and a dismissal's reason", () => {
    expect(parseMemoryEdit({ kind: "convention", text: "Use X." })).toEqual({
      kind: "convention",
      text: "Use X.",
      reason: null,
    });
    expect(parseMemoryEdit({ kind: "dismissal", text: "Y", reason: "intentional" })).toEqual({
      kind: "dismissal",
      text: "Y",
      reason: "intentional",
    });
  });

  it("refuses a missing or wrong reason, unknown fields and oversized text", () => {
    for (const bad of [
      null,
      [],
      "text",
      { kind: "dismissal", text: "Y" },
      { kind: "convention", text: "Y", reason: "intentional" },
      { kind: "note", text: "Y" },
      { kind: "convention", text: "" },
      { kind: "convention", text: "x".repeat(2001) },
      { kind: "convention", text: "Y", origin: "learned" },
      { kind: "convention", text: "Y", evidence: {} },
    ]) {
      expect(parseMemoryEdit(bad)).toBeNull();
    }
  });
});

describe("parseMemorySwitch", () => {
  it("reads exactly one boolean field", () => {
    expect(parseMemorySwitch({ disabled: true }, "disabled")).toBe(true);
    expect(parseMemorySwitch({ enabled: false }, "enabled")).toBe(false);
    expect(parseMemorySwitch({ disabled: "yes" }, "disabled")).toBeNull();
    expect(parseMemorySwitch({ disabled: true, x: 1 }, "disabled")).toBeNull();
    expect(parseMemorySwitch({ enabled: true }, "disabled")).toBeNull();
    expect(parseMemorySwitch(null, "disabled")).toBeNull();
  });
});
