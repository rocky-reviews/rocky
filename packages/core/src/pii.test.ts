import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_KNOWN_PEOPLE,
  MAX_KNOWN_PERSON_LENGTH,
  MAX_SCRUB_INPUT_LENGTH,
  PII_PLACEHOLDER,
  scrubPersonalIdentifiers,
  type ScrubReport,
} from "./pii.js";

/**
 * P8-1 acceptance criterion "PII scrubber tests" (ADR 0036 §2, threats P2, P9, P10). A table of
 * cases per class, Unicode and obfuscated spellings, the false positives on code the scrubber
 * must not produce, and a property: a listed person never survives.
 */

const PEOPLE = ["alice", "Alice Smith", "bob-the-builder", "Zoë Müller", "李雷"];

const scrub = (text: string, people: readonly string[] = PEOPLE) =>
  scrubPersonalIdentifiers(text, { people }).text;

const counts = (text: string, people: readonly string[] = PEOPLE): ScrubReport =>
  scrubPersonalIdentifiers(text, { people }).replaced;

interface Case {
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}

const table = (cases: readonly Case[]) => {
  for (const c of cases) {
    it(c.name, () => {
      expect(scrub(c.input)).toBe(c.expected);
    });
  }
};

describe("emails", () => {
  table([
    { name: "plain", input: "mail alice@example.com first", expected: "mail [email] first" },
    { name: "upper case and plus", input: "Ask Bob+Ops@Example.ORG.", expected: "Ask [email]." },
    {
      name: "unicode local part and domain",
      input: "write to zoë@müller.de",
      expected: "write to [email]",
    },
    {
      name: "url-encoded",
      input: "?user=jane%40example.com&x=1",
      expected: "?user=[email]&x=1",
    },
    {
      name: "obfuscated with brackets",
      input: "jane [at] example [dot] com knows",
      expected: "[email] knows",
    },
    {
      name: "obfuscated with parentheses and a real dot",
      input: "jane(at)example.com knows",
      expected: "[email] knows",
    },
    {
      name: "obfuscated with words",
      input: "mail jane at example dot com please",
      expected: "mail [email] please",
    },
    {
      name: "name and angle-bracket address",
      input: "Author: Jane Doe <jane@example.com>",
      expected: "Author: [person] <[email]>",
    },
    {
      name: "not a package specifier",
      input: "pino@10.4.0 is fine",
      expected: "pino@10.4.0 is fine",
    },
    { name: "not a bare host", input: "user@localhost works", expected: "user@localhost works" },
    { name: "not 'look at the docs'", input: "look at the docs.", expected: "look at the docs." },
    {
      name: "not 'look at example.com' (a spelled 'at' needs a spelled 'dot')",
      input: "look at example.com for details",
      expected: "look at example.com for details",
    },
  ]);
});

describe("url credentials", () => {
  table([
    {
      name: "userinfo in a url",
      input: "clone https://alice:hunter2@git.example.com/x.git now",
      expected: "clone https://[user]@git.example.com/x.git now",
    },
    {
      name: "a url without credentials",
      input: "see https://example.com/a@b",
      expected: "see https://example.com/a@b",
    },
  ]);
});

describe("@handles", () => {
  table([
    { name: "plain mention", input: "@octocat said no", expected: "[user] said no" },
    { name: "with hyphen", input: "cc @octo-cat-2", expected: "cc [user]" },
    { name: "end of sentence", input: "ask @octocat.", expected: "ask [user]." },
    { name: "in parentheses", input: "(@octocat)", expected: "([user])" },
    { name: "not an npm scope", input: "use @types/node here", expected: "use @types/node here" },
    {
      name: "not a scoped package name",
      input: "@rocky-reviews/core",
      expected: "@rocky-reviews/core",
    },
    {
      name: "not a decorator call",
      input: "add @Injectable() to it",
      expected: "add @Injectable() to it",
    },
    {
      name: "not a JSDoc tag",
      input: "document every @param and @returns",
      expected: "document every @param and @returns",
    },
    {
      name: "not a CSS at-rule",
      input: "@media queries go last",
      expected: "@media queries go last",
    },
    { name: "not a Java annotation", input: "mark it @Override", expected: "mark it @Override" },
    {
      name: "not a TypeScript directive",
      input: "no @ts-ignore in src",
      expected: "no @ts-ignore in src",
    },
    {
      name: "not inside a word",
      input: "foo@bar is not a handle",
      expected: "foo@bar is not a handle",
    },
    {
      name: "an unknown tag is scrubbed (the safe failure)",
      input: "@fixme later",
      expected: "[user] later",
    },
  ]);
});

describe("known people", () => {
  table([
    { name: "login", input: "alice merged it", expected: "[person] merged it" },
    { name: "login, any case", input: "ALICE merged it", expected: "[person] merged it" },
    { name: "login with hyphens", input: "ping bob-the-builder", expected: "ping [person]" },
    { name: "full display name", input: "per Alice Smith", expected: "per [person]" },
    { name: "full name, lower case", input: "per alice smith", expected: "per [person]" },
    { name: "possessive", input: "Alice's branch", expected: "[person] branch" },
    { name: "curly possessive", input: "Alice’s branch", expected: "[person] branch" },
    {
      name: "surname token as written",
      input: "Smith prefers tabs",
      expected: "[person] prefers tabs",
    },
    {
      name: "a surname token that is also a word is kept in lower case",
      input: "a smith hammers",
      expected: "a smith hammers",
    },
    { name: "unicode name", input: "Zoë Müller wrote this", expected: "[person] wrote this" },
    {
      name: "unicode token, NFKC input",
      input: "Müller wrote this",
      expected: "[person] wrote this",
    },
    {
      name: "unicode name, lower case",
      input: "zoë müller wrote this",
      expected: "[person] wrote this",
    },
    { name: "CJK name when listed", input: "李雷 reviewed it", expected: "[person] reviewed it" },
    {
      name: "zero-width characters inside",
      input: "al​i‍ce merged it",
      expected: "[person] merged it",
    },
    { name: "soft hyphen inside", input: "al­ice merged it", expected: "[person] merged it" },
    { name: "cyrillic look-alikes", input: "аliсе merged it", expected: "[person] merged it" },
    { name: "full-width letters", input: "ａｌｉｃｅ merged it", expected: "[person] merged it" },
    {
      name: "not inside an identifier (camelCase)",
      input: "aliceValidator()",
      expected: "aliceValidator()",
    },
    { name: "not inside an identifier (snake_case)", input: "alice_id", expected: "alice_id" },
    { name: "not a substring", input: "malice and palaces", expected: "malice and palaces" },
    {
      name: "dotted member access is scrubbed",
      input: "alice.validate()",
      expected: "[person].validate()",
    },
  ]);

  it("ignores people shorter than two characters, longer than the cap, or beyond the list cap", () => {
    const people = ["a", "x".repeat(MAX_KNOWN_PERSON_LENGTH + 1), "bob"];
    expect(scrub("a bob x", people)).toBe("a [person] x");
    const many = Array.from({ length: MAX_KNOWN_PEOPLE + 1 }, (_, i) => `person${i}`);
    const out = scrub(`person0 person${MAX_KNOWN_PEOPLE}`, many);
    expect(out.startsWith("[person] ")).toBe(true);
    expect(out).toBe(`[person] person${MAX_KNOWN_PEOPLE}`);
  });

  it("escapes regex metacharacters in names", () => {
    expect(scrub("a.b+c (d) said hi", ["a.b+c (d)"])).toBe("[person] said hi");
    expect(scrub("aXb+c said hi", ["a.b+c (d)"])).toBe("aXb+c said hi");
  });
});

describe("names by context", () => {
  table([
    { name: "honorific", input: "ask Dr. Ada Lovelace", expected: "ask Dr. [person]" },
    {
      name: "honorific without a dot",
      input: "Mrs Grace Hopper agreed",
      expected: "Mrs [person] agreed",
    },
    { name: "thanks", input: "thanks Carol for the fix", expected: "thanks [person] for the fix" },
    {
      name: "thanks to",
      input: "thanks to Carol Danvers for the fix",
      expected: "thanks to [person] for the fix",
    },
    { name: "cc", input: "cc Dave", expected: "cc [person]" },
    {
      name: "according to",
      input: "according to Erin we keep it",
      expected: "according to [person] we keep it",
    },
    { name: "reviewed by", input: "reviewed by Frank Castle", expected: "reviewed by [person]" },
    {
      name: "speech verb",
      input: "Grace suggested a retry",
      expected: "[person] suggested a retry",
    },
    {
      name: "two-token name before a speech verb",
      input: "Grace Hopper suggested a retry",
      expected: "[person] suggested a retry",
    },
    {
      name: "git trailer",
      input: "Co-authored-by: Heidi Klum <h@example.com>",
      expected: "Co-authored-by: [person]",
    },
    {
      name: "signed-off trailer",
      input: "Signed-off-by: Ivan Petrov",
      expected: "Signed-off-by: [person]",
    },
    { name: "not an acronym", input: "per RFC 7231", expected: "per RFC 7231" },
    {
      name: "not an acronym after thanks",
      input: "thanks CI for nothing",
      expected: "thanks CI for nothing",
    },
    {
      name: "not a stop word",
      input: "The Team decided to wait",
      expected: "The Team decided to wait",
    },
    {
      name: "not a product before a verb that is not speech",
      input: "Postgres requires a lock",
      expected: "Postgres requires a lock",
    },
    {
      name: "not a lower-case word after thanks",
      input: "thanks for the fix",
      expected: "thanks for the fix",
    },
    {
      name: "not a capitalised common noun after thanks (stop word)",
      input: "thanks Everyone",
      expected: "thanks Everyone",
    },
  ]);
});

describe("phone numbers and addresses", () => {
  table([
    { name: "international", input: "call +1 415 555 0123 now", expected: "call [phone] now" },
    { name: "parentheses and dashes", input: "call (415) 555-0123", expected: "call [phone]" },
    { name: "dashes", input: "415-555-0123", expected: "[phone]" },
    { name: "uk", input: "+44 20 7946 0958", expected: "[phone]" },
    { name: "dots", input: "+49.30.1234.5678", expected: "[phone]" },
    { name: "not a date", input: "since 2026-10-30 12:00", expected: "since 2026-10-30 12:00" },
    {
      name: "not a european date",
      input: "due 30.10.2026 at noon",
      expected: "due 30.10.2026 at noon",
    },
    {
      name: "not a line range",
      input: "lines 100-200 and 1000-2000",
      expected: "lines 100-200 and 1000-2000",
    },
    { name: "not a version", input: "v1.2.3 and 10.4.0", expected: "v1.2.3 and 10.4.0" },
    {
      name: "not a sha",
      input: "sha 1234567890123456789012345678901234567890",
      expected: "sha 1234567890123456789012345678901234567890",
    },
    { name: "not a bare number", input: "id 1730000000", expected: "id 1730000000" },
    { name: "not an issue number", input: "see #123456789", expected: "see #123456789" },
    {
      name: "not a timestamp",
      input: "at 2026-10-30T12:00:00Z",
      expected: "at 2026-10-30T12:00:00Z",
    },
    { name: "ipv4", input: "from 192.168.1.10 only", expected: "from [address] only" },
    { name: "ipv4 is not a phone", input: "10.0.0.1", expected: "[address]" },
    { name: "not an ip (five octets)", input: "1.2.3.4.5", expected: "1.2.3.4.5" },
    { name: "not an ip (octet too large)", input: "999.1.1.1", expected: "999.1.1.1" },
  ]);
});

describe("code identifiers and ordinary prose stay", () => {
  table([
    {
      name: "two capitalised words",
      input: "Pull Request and Row Level Security",
      expected: "Pull Request and Row Level Security",
    },
    { name: "library names", input: "React Query over Redux", expected: "React Query over Redux" },
    {
      name: "member access",
      input: "Object.assign(target, source)",
      expected: "Object.assign(target, source)",
    },
    {
      name: "paths",
      input: "src/invite.ts and docs/people/alice.md",
      expected: "src/invite.ts and docs/people/[person].md",
    },
    {
      name: "sentence start",
      input: "Use the shared validator for emails.",
      expected: "Use the shared validator for emails.",
    },
    { name: "empty", input: "", expected: "" },
    { name: "only spaces", input: "   ", expected: "   " },
  ]);
});

describe("the result", () => {
  it("counts replacements per class", () => {
    expect(counts("alice <a@b.io> and @bob at +1 415 555 0123 from 10.0.0.1 cc Carol")).toEqual({
      person: 2,
      email: 1,
      handle: 1,
      phone: 1,
      address: 1,
    });
    expect(scrubPersonalIdentifiers("nothing here").total).toBe(0);
  });

  it("is idempotent", () => {
    const once = scrub("alice <a@b.io> and @bob at +1 415 555 0123, cc Carol, Dr. Who");
    expect(scrub(once)).toBe(once);
  });

  it("never produces a markdown link from a placeholder", () => {
    // `[person](…)` would read as a link; the scrubber keeps a space before a parenthesis.
    expect(scrub("alice(http://x)")).toBe("[person] (http://x)");
    expect(scrub("@bob(not a decorator because of the people list?)")).toBe(
      "@bob(not a decorator because of the people list?)",
    );
  });

  it("removes invisible characters and normalises to NFKC even without a match", () => {
    expect(scrub("ﬁle​ name")).toBe("file name");
  });

  it("refuses input beyond the scan limit", () => {
    expect(() => scrubPersonalIdentifiers("x".repeat(MAX_SCRUB_INPUT_LENGTH + 1))).toThrow(
      RangeError,
    );
    expect(scrubPersonalIdentifiers("x".repeat(MAX_SCRUB_INPUT_LENGTH)).text.length).toBe(
      MAX_SCRUB_INPUT_LENGTH,
    );
  });

  it("exposes the placeholders", () => {
    expect(PII_PLACEHOLDER).toEqual({
      person: "[person]",
      email: "[email]",
      handle: "[user]",
      phone: "[phone]",
      address: "[address]",
    });
  });
});

describe("property: a listed person never survives", () => {
  const login = fc
    .stringMatching(/^[a-z0-9][a-z0-9-]{1,20}[a-z0-9]$/)
    .filter((s) => !s.includes("--"));
  const filler = fc.stringMatching(/^[ \p{L}\p{N}.,;:!?()'"-]{0,30}$/u);

  const placeholders = Object.values(PII_PLACEHOLDER).join("");

  it("in any case, with punctuation around and zero-width characters inside", () => {
    fc.assert(
      fc.property(login, filler, filler, fc.boolean(), (name, before, after, upper) => {
        // The name must not already be part of the filler or of a placeholder, or `includes`
        // would see it for reasons unrelated to the scrub.
        fc.pre(!`${before}${after}${placeholders}`.toLowerCase().includes(name));
        const spelled = upper ? name.toUpperCase() : name;
        const hidden = Array.from(spelled).join("​");
        for (const text of [`${before} ${spelled} ${after}`, `${before} ${hidden}. ${after}`]) {
          const out = scrub(text, [name]).toLowerCase();
          expect(out.includes(name)).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never throws on arbitrary text, including the whole Unicode range", () => {
    const text = fc.oneof(
      fc.string({ maxLength: 500 }),
      fc.string({ unit: "binary", maxLength: 500 }),
    );
    const people = fc.array(fc.string({ unit: "binary", maxLength: 20 }), { maxLength: 10 });
    fc.assert(
      fc.property(text, people, (t, p) => {
        const result = scrubPersonalIdentifiers(t, { people: p });
        expect(typeof result.text).toBe("string");
        expect(result.total).toBe(
          result.replaced.person +
            result.replaced.email +
            result.replaced.handle +
            result.replaced.phone +
            result.replaced.address,
        );
      }),
      { numRuns: 300 },
    );
  });
});
