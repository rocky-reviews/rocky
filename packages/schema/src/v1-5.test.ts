import { describe, expect, it } from "vitest";
import {
  BASE_SCHEMA_VERSION,
  isSupportedVersion,
  requiredSchemaVersion,
  SCHEMA_VERSION,
  TLDR_SCHEMA_VERSION,
} from "./document.js";
import { Finding, RestoredDismissal } from "./findings.js";
import { applyKnownFields } from "./known-fields.js";
import {
  expectAccepted,
  expectRejected,
  pr847,
  pr847v14,
  pr847WithSummary,
} from "./test-helpers.js";

/**
 * Schema 1.5 (P8-2, ADR 0037 §4): `findings[].restored`, written by the pipeline when a dismissal
 * entry covered a finding but the file is one where no suppression stands (triaged critical or a
 * rule floor), so the draft is shown for a double-check. Additive for readers: every 1.0 to 1.4
 * document still parses, and a document without a restored finding is stamped as before.
 */

const RESTORED = {
  entry: {
    entryId: "mem-812",
    text: "Dismissed as intentional: Invitations can be reused after they're accepted",
    source: "dismissal · PR #812",
  },
  path: "src/auth/invitations.ts",
  dismissedAs: "intentional",
  shownBecause: "critical_file",
} as const;

describe("schema 1.5: version policy", () => {
  it("is 1.5.0 and still reads 1.0 to 1.4 documents, but no newer minor", () => {
    expect(SCHEMA_VERSION).toBe("1.5.0");
    for (const version of ["1.0.0", "1.1.3", "1.2.0", "1.3.0", "1.4.0", "1.5.0", "1.5.9"])
      expect(isSupportedVersion(version), version).toBe(true);
    for (const version of ["1.6.0", "1.50.0", "2.0.0"])
      expect(isSupportedVersion(version), version).toBe(false);
  });

  it("stamps 1.5.0 only on a document with a restored finding, and the older stamps otherwise", () => {
    const tldr = { tldr: ["a", "b"] };
    expect(requiredSchemaVersion({ briefing: tldr, findings: [{ restored: RESTORED }] })).toBe(
      SCHEMA_VERSION,
    );
    expect(
      requiredSchemaVersion({ briefing: { summary: "s" }, findings: [{ restored: {} }] }),
    ).toBe(SCHEMA_VERSION);
    expect(requiredSchemaVersion({ briefing: tldr, findings: [{}, { restored: undefined }] })).toBe(
      TLDR_SCHEMA_VERSION,
    );
    expect(requiredSchemaVersion({ briefing: { summary: "s" }, findings: [] })).toBe(
      BASE_SCHEMA_VERSION,
    );
    // Only a finding object counts; anything else is refused by the parser, not stamped 1.5.
    for (const findings of [null, "a", 1, {}, [null, "restored", 1]])
      expect(requiredSchemaVersion({ briefing: tldr, findings }), String(findings)).toBe(
        TLDR_SCHEMA_VERSION,
      );
  });

  it("the overlay stamps from the findings: 1.5.0 with a restored one, 1.4.0 without", () => {
    const doc = pr847();
    const { briefing, triage, findings, graph, provenance } = doc;
    const stamped = applyKnownFields({ briefing, triage, findings, graph }, provenance);
    expect(expectAccepted(stamped).schemaVersion).toBe(SCHEMA_VERSION);
    const old = pr847v14();
    const without = applyKnownFields(
      { briefing: old.briefing, triage, findings: old.findings, graph },
      provenance,
    );
    expect(expectAccepted(without).schemaVersion).toBe(TLDR_SCHEMA_VERSION);
  });
});

describe("schema 1.5: findings[].restored", () => {
  it("the fixture carries one on F3 (an auth file triaged critical), and it reads back as written", () => {
    const value = expectAccepted(pr847());
    expect(value.schemaVersion).toBe("1.5.0");
    const f3 = value.findings.find((finding) => finding.id === "F3");
    expect(f3?.restored).toEqual(RESTORED);
    expect(f3?.memory).toEqual([]);
    // The entry argued against the finding: it is not among the memory the analysis applied.
    expect(value.briefing.memoryApplied.map((ref) => ref.entryId)).not.toContain("mem-812");
  });

  it("takes the entry as a memory ref, a repository path and the two fixed enums, nothing else", () => {
    const at = (restored: unknown) => {
      const doc = pr847v14();
      const f3 = doc.findings.find((finding) => finding.id === "F3")!;
      f3.restored = restored as never;
      return doc;
    };
    for (const reason of ["not_an_issue", "intentional", "not_worth_it", "handled_elsewhere"])
      expectAccepted(at({ ...RESTORED, dismissedAs: reason }));
    expectAccepted(at({ ...RESTORED, shownBecause: "rule_floor" }));
    const index = pr847v14().findings.findIndex((finding) => finding.id === "F3");
    const path = `findings[${index}].restored`;
    expectRejected(
      at({ ...RESTORED, dismissedAs: "wrong" }),
      "INVALID_SHAPE",
      `${path}.dismissedAs`,
    );
    expectRejected(
      at({ ...RESTORED, shownBecause: "model" }),
      "INVALID_SHAPE",
      `${path}.shownBecause`,
    );
    expectRejected(at({ ...RESTORED, path: "../etc/passwd" }), "INVALID_SHAPE", `${path}.path`);
    expectRejected(
      at({ ...RESTORED, entry: { ...RESTORED.entry, text: "two\nlines" } }),
      "INVALID_SHAPE",
      `${path}.entry.text`,
    );
    expectRejected(at({ ...RESTORED, why: "because" }), "INVALID_SHAPE", path);
    expectRejected(at({ entry: RESTORED.entry }), "INVALID_SHAPE", `${path}.path`);
    expect(RestoredDismissal.safeParse(RESTORED).success).toBe(true);
    expect(Finding.safeParse({ ...pr847().findings[0], restored: null }).success).toBe(false);
  });

  it("is optional: a 1.4 document without it is accepted unchanged", () => {
    const value = expectAccepted(pr847v14());
    expect(value.findings.every((finding) => finding.restored === undefined)).toBe(true);
    expect(value.schemaVersion).toBe("1.4.0");
    expect(expectAccepted(pr847WithSummary()).schemaVersion).toBe("1.1.0");
  });

  it("the published JSON Schema lists it as optional on a finding", () => {
    const schema = Finding.toJSONSchema({ io: "input" });
    expect(schema.required).not.toContain("restored");
    expect(Object.keys(schema.properties ?? {})).toContain("restored");
  });
});
