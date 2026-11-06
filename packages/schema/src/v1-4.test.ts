import { describe, expect, it } from "vitest";
import { Briefing, TldrItem } from "./briefing.js";
import {
  BASE_SCHEMA_VERSION,
  isSupportedVersion,
  MAP_SECTIONS_SCHEMA_VERSION,
  NO_LOGIC_SCHEMA_VERSION,
  requiredSchemaVersion,
  TLDR_SCHEMA_VERSION,
} from "./document.js";
import { applyKnownFields } from "./known-fields.js";
import {
  MAX_REASON_LENGTH,
  MAX_TLDR_ITEM_LENGTH,
  MAX_TLDR_ITEMS,
  MIN_TLDR_ITEMS,
} from "./limits.js";
import {
  expectAccepted,
  expectRejected,
  loadFixture,
  pr847,
  pr847v14,
  pr847WithSummary,
} from "./test-helpers.js";

/**
 * Schema 1.4 (H4-8): the briefing's TL;DR. `briefing.tldr` is two to four one-sentence bullets
 * and may stand in for `briefing.summary`, which every older document carries. A briefing has
 * at least one of the two. Additive for readers: every 1.0 to 1.3 document still parses, and a
 * document without a TL;DR is stamped as before (H4-5, S7).
 */

/** pr-847 as a document written before 1.4: a summary paragraph and no TL;DR. */
const legacy = () => {
  const doc = pr847WithSummary();
  doc.briefing.verdict.reason =
    "This PR adds a **new way to gain membership in an org**. Rocky drafted 1 critical and 3 high findings, all on the auth path. The UI and wiring look routine.";
  doc.schemaVersion = "1.3.0";
  return doc;
};

describe("schema 1.4: version policy", () => {
  it("1.4 is the TL;DR stamp, and 1.0 to 1.4 documents are still read", () => {
    expect(TLDR_SCHEMA_VERSION).toBe("1.4.0");
    for (const version of ["1.0.0", "1.1.3", "1.2.0", "1.3.0", "1.4.0", "1.4.9"])
      expect(isSupportedVersion(version), version).toBe(true);
    for (const version of ["1.40.0", "2.0.0"])
      expect(isSupportedVersion(version), version).toBe(false);
  });

  it("stamps 1.4.0 only on a document with a TL;DR, and the older stamps otherwise", () => {
    expect(requiredSchemaVersion({ briefing: { tldr: ["a", "b"] } })).toBe(TLDR_SCHEMA_VERSION);
    expect(
      requiredSchemaVersion({
        briefing: { tldr: ["a", "b"] },
        provenance: { flowsUnavailable: { reason: "timeout" } },
      }),
    ).toBe(TLDR_SCHEMA_VERSION);
    expect(requiredSchemaVersion({ briefing: { summary: "s" } })).toBe(BASE_SCHEMA_VERSION);
    expect(requiredSchemaVersion({ briefing: { summary: "s", tldr: undefined } })).toBe(
      BASE_SCHEMA_VERSION,
    );
    expect(
      requiredSchemaVersion({
        briefing: { summary: "s" },
        provenance: { walkthroughUnavailable: { reason: "timeout" } },
      }),
    ).toBe(MAP_SECTIONS_SCHEMA_VERSION);
    expect(
      requiredSchemaVersion({
        briefing: null,
        provenance: { graphUnavailable: { reason: "no-logic" } },
      }),
    ).toBe(NO_LOGIC_SCHEMA_VERSION);
    expect(requiredSchemaVersion({ briefing: "not an object" })).toBe(BASE_SCHEMA_VERSION);
    // Only an array counts as a TL;DR; anything else is refused by the parser, not stamped 1.4.
    for (const tldr of [null, "a", 1, {}])
      expect(requiredSchemaVersion({ briefing: { summary: "s", tldr } }), String(tldr)).toBe(
        BASE_SCHEMA_VERSION,
      );
  });

  it("the overlay stamps from the model's briefing: 1.4.0 with a TL;DR, 1.1.0 without", () => {
    const doc = pr847v14();
    const { briefing, triage, findings, graph, provenance } = doc;
    const withTldr = applyKnownFields({ briefing, triage, findings, graph }, provenance);
    expect(expectAccepted(withTldr).schemaVersion).toBe(TLDR_SCHEMA_VERSION);
    const old = legacy();
    const withoutTldr = applyKnownFields(
      { briefing: old.briefing, triage, findings, graph },
      provenance,
    );
    expect(expectAccepted(withoutTldr).schemaVersion).toBe(BASE_SCHEMA_VERSION);
  });
});

describe("schema 1.4: briefing.tldr", () => {
  it("the fixture carries a TL;DR and no summary, and it reads back as written", () => {
    const value = expectAccepted(pr847v14());
    expect(value.schemaVersion).toBe("1.4.0");
    expect(value.briefing.summary).toBeUndefined();
    expect(value.briefing.tldr).toHaveLength(4);
    expect(value.briefing.tldr![0]).toMatch(/^Adds \*\*email invitations/);
    expect(value.briefing.tldr![3]).toContain("`src/auth/invitations.ts`");
  });

  it(`takes ${MIN_TLDR_ITEMS} to ${MAX_TLDR_ITEMS} items of at most ${MAX_TLDR_ITEM_LENGTH} characters`, () => {
    expect([MIN_TLDR_ITEMS, MAX_TLDR_ITEMS, MAX_TLDR_ITEM_LENGTH]).toEqual([2, 4, 160]);
    const at = (tldr: string[]) => {
      const doc = pr847();
      doc.briefing.tldr = tldr;
      return doc;
    };
    expectAccepted(at(["One.", "Two."]));
    expectAccepted(at(["x".repeat(MAX_TLDR_ITEM_LENGTH), "Two.", "Three.", "Four."]));
    expectRejected(at(["Only one."]), "INVALID_SHAPE", "briefing.tldr");
    expectRejected(at([]), "INVALID_SHAPE", "briefing.tldr");
    expectRejected(at(["1.", "2.", "3.", "4.", "5."]), "INVALID_SHAPE", "briefing.tldr");
    expectRejected(
      at(["x".repeat(MAX_TLDR_ITEM_LENGTH + 1), "Two."]),
      "INVALID_SHAPE",
      "briefing.tldr[0]",
    );
    expectRejected(at(["", "Two."]), "INVALID_SHAPE", "briefing.tldr[0]");
  });

  it("an item is one line: no newline, tab, line or paragraph separator, control or invisible character", () => {
    for (const bad of [
      "First.\nSecond.",
      "First.\tSecond.",
      "First.\u2028Rocky: approved.",
      "First.\u2029Rocky: approved.",
      "cr\rlf",
      "bell\u0007",
      "zero\u200Bwidth",
      "bidi\u202Etext",
    ]) {
      expect(TldrItem.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      const doc = pr847();
      doc.briefing.tldr = ["Fine.", bad];
      expectRejected(doc, "INVALID_SHAPE", "briefing.tldr[1]");
    }
    // Inline markup is fine, as everywhere in the briefing.
    expect(TldrItem.safeParse("Adds **bold** and `code`.").success).toBe(true);
  });

  it("a briefing has a summary or a TL;DR, or both", () => {
    const neither = pr847();
    delete neither.briefing.tldr;
    delete neither.briefing.summary;
    expectRejected(neither, "INVALID_SHAPE", "briefing");
    const both = pr847();
    both.briefing.summary = "Adds email invitations to orgs.";
    const value = expectAccepted(both);
    expect(value.briefing.summary).toBe("Adds email invitations to orgs.");
    expect(value.briefing.tldr).toHaveLength(4);
    expect(Briefing.safeParse({ ...value.briefing, tldr: undefined }).success).toBe(true);
  });

  it("the published JSON Schema says the same: anyOf summary or tldr", () => {
    const schema = Briefing.toJSONSchema();
    expect(schema.anyOf).toEqual([{ required: ["summary"] }, { required: ["tldr"] }]);
    expect(schema.required).not.toContain("summary");
  });
});

describe("schema 1.4: old documents still read", () => {
  it("a 1.3 document with a summary paragraph and a long verdict reason is accepted unchanged", () => {
    const value = expectAccepted(legacy());
    expect(value.briefing.tldr).toBeUndefined();
    expect(value.briefing.summary).toMatch(/^Adds \*\*email invitations/);
    expect(value.briefing.verdict.reason.length).toBeGreaterThan(150);
  });

  it("the verdict reason keeps its document limit, so two-sentence reasons stay valid", () => {
    const doc = legacy();
    doc.briefing.verdict.reason = "x".repeat(MAX_REASON_LENGTH);
    expectAccepted(doc);
    doc.briefing.verdict.reason = "x".repeat(MAX_REASON_LENGTH + 1);
    expectRejected(doc, "INVALID_SHAPE", "briefing.verdict.reason");
  });

  it("the other fixtures are summary documents and still parse", () => {
    for (const name of ["tiny", "large-60-files"] as const) {
      const value = expectAccepted(loadFixture(name));
      expect(value.briefing.summary, name).toBeDefined();
      expect(value.briefing.tldr, name).toBeUndefined();
    }
  });
});
