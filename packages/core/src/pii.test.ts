import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_KNOWN_PEOPLE,
  MAX_KNOWN_PEOPLE_ENTRIES,
  MAX_KNOWN_PEOPLE_PER_KEY,
  MAX_KNOWN_PERSON_LENGTH,
  MAX_SCRUB_INPUT_LENGTH,
  matchesAsBareWord,
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

const table = (cases: readonly Case[], people: readonly string[] = PEOPLE) => {
  for (const c of cases) {
    it(c.name, () => {
      expect(scrub(c.input, people)).toBe(c.expected);
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
      name: "not a dotted decorator (S5)",
      input: "use @app.route here",
      expected: "use @app.route here",
    },
    {
      name: "not a module decorator (S5)",
      input: "wrap it in @functools.cache",
      expected: "wrap it in @functools.cache",
    },
    {
      name: "not a CamelCase decorator (S5)",
      input: "add @HostBinding to it",
      expected: "add @HostBinding to it",
    },
    { name: "a single-capital handle is a person", input: "ask @Alice", expected: "ask [user]" },
    {
      name: "a handle before a dot and a space",
      input: "ask @octocat. Then",
      expected: "ask [user]. Then",
    },
    {
      name: "inside inline code too (fix round 2)",
      input: "run `@octocat`",
      expected: "run `[user]`",
    },
    {
      name: "an unlisted CamelCase handle is a person (fix round 2)",
      input: "ask @JohnSmith",
      expected: "ask [user]",
    },
    {
      name: "an unlisted CamelCase handle mid-sentence",
      input: "ask @DavidSmith about it",
      expected: "ask [user] about it",
    },
    {
      name: "a CamelCase decorator alone on its line",
      input: "  @MyDecorator\nclass X {}",
      expected: "  @MyDecorator\nclass X {}",
    },
    {
      name: "a handle in backticks before a verb",
      input: "`@octocat` approved",
      expected: "`[user]` approved",
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
      name: "display-name parts match in any case (fix round 3)",
      input: "smith hammers; SMITH too",
      expected: "[person] hammers; [person] too",
    },
    {
      name: "a dictionary-word part stays outside person positions",
      input: "a brown hammer",
      expected: "a brown hammer",
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
    {
      name: "inside inline code, a listed login is still a person",
      input: "see `alice`",
      expected: "see `[person]`",
    },
  ]);

  it("ignores people shorter than two characters or longer than the cap", () => {
    const people = ["a", "x".repeat(MAX_KNOWN_PERSON_LENGTH + 1), "bobby"];
    expect(scrub("a bobby x", people)).toBe("a [person] x");
  });

  describe("listed people with short names never survive bare (fix round 2 blocker)", () => {
    table(
      [
        {
          name: "four letters",
          input: "john fixed the cache",
          expected: "[person] fixed the cache",
        },
        { name: "capitalised four letters", input: "Eric fixed it", expected: "[person] fixed it" },
        {
          name: "after per, with a comma",
          input: "per anna, keep it",
          expected: "per [person], keep it",
        },
        { name: "three letters, possessive", input: "bob's branch", expected: "[person] branch" },
        {
          name: "first name of a display name",
          input: "Juan rewrote it",
          expected: "[person] rewrote it",
        },
        { name: "accented surname", input: "Pérez rewrote it", expected: "[person] rewrote it" },
        { name: "whole display name", input: "Eric Li merged it", expected: "[person] merged it" },
        { name: "a two-letter token is weak", input: "Li alone stays", expected: "Li alone stays" },
        {
          name: "a two-letter token in a person position",
          input: "cc Li",
          expected: "cc [person]",
        },
        { name: "four-letter surname", input: "Moss said so", expected: "[person] said so" },
        {
          name: "parts in any case (fix round 3)",
          input: "eric fixed it; MOSS fixed it",
          expected: "[person] fixed it; [person] fixed it",
        },
        {
          name: "a weak part inside inline code in a person position",
          input: "`cc Li`",
          expected: "`cc [person]`",
        },
      ],
      ["john", "eric", "anna", "bob", "Eric Li", "Juan Pérez", "Kate Moss"],
    );
  });

  it("refuses more distinct people than the cap instead of shortening the list (security M2)", () => {
    const many = Array.from({ length: MAX_KNOWN_PEOPLE + 1 }, (_, i) => `person-${i}`);
    expect(() => scrub("x", many)).toThrow(RangeError);
    // Duplicates after folding and case-folding count once.
    const dupes = Array.from({ length: MAX_KNOWN_PEOPLE }, (_, i) => `person-${i}`);
    expect(scrub("PERSON-4999 wrote it", [...dupes, "Person-0", "\uFF50erson-1", "person-2"])).toBe(
      "[person] wrote it",
    );
  });

  it("stays fast at the cap with realistic multi-word display names (fix rounds 3 and 5)", () => {
    // 50 000 three-word names: 50 000 whole names plus their parts examined (200 000, the
    // entries cap fits them). Bound per call (index + scrub of a 300-character text).
    const names = Array.from(
      { length: MAX_KNOWN_PEOPLE },
      (_, i) => `First${i} Middle${i % 977} Last${i}`,
    );
    const text = `${"Review notes: keep the shared validator; ".repeat(6)} First7 Middle7 Last7 agreed`;
    const runs: number[] = [];
    let out = "";
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      out = scrub(text, names);
      runs.push(performance.now() - started);
    }
    expect(out.endsWith("[person] agreed")).toBe(true);
    expect(Math.min(...runs)).toBeLessThan(1000);
  });

  it("refuses, quickly, lists whose names and parts exceed the entries cap (fix round 5)", () => {
    const bound = (people: string[]) => {
      const started = performance.now();
      expect(() => scrub("plain text", people)).toThrow(RangeError);
      expect(performance.now() - started).toBeLessThan(1000);
    };
    // Twelve hyphenated parts: 1 + 12 + 24 entries per name.
    bound(
      Array.from({ length: MAX_KNOWN_PEOPLE }, (_, i) =>
        Array.from({ length: 12 }, (_, w) => `A${w}-b${i % 7}`).join(" "),
      ),
    );
    // Twelve plain words (short enough to stay under the 100-character name cap).
    bound(
      Array.from({ length: MAX_KNOWN_PEOPLE }, (_, i) =>
        Array.from({ length: 12 }, (_, w) => `W${w}n${i % 997}`).join(" "),
      ),
    );
    // Fifty one-letter words, mostly duplicates: examined parts count, not only indexed ones.
    bound(
      Array.from({ length: MAX_KNOWN_PEOPLE }, (_, i) =>
        Array.from({ length: 50 }, (_, w) => String.fromCharCode(97 + ((i + w) % 26))).join(" "),
      ),
    );
    expect(MAX_KNOWN_PEOPLE_ENTRIES).toBeGreaterThanOrEqual(4 * MAX_KNOWN_PEOPLE);
  });

  it("stays fast when 50 000 names share their first two words over 2 000 characters (fix round 5)", () => {
    const shared = Array.from({ length: MAX_KNOWN_PEOPLE }, (_, i) => `John Smith Last${i}`);
    const weak = Array.from({ length: MAX_KNOWN_PEOPLE }, (_, i) => `Go Go Last${i}`);
    for (const [people, text, expected] of [
      [shared, "john smith ".repeat(181), "[person] [person] ".repeat(181)],
      // `Go` is weak (dictionary, two letters): bare occurrences stay.
      [weak, "go go ".repeat(333), "go go ".repeat(333)],
    ] as const) {
      const started = performance.now();
      expect(scrub(text, people)).toBe(expected);
      expect(performance.now() - started).toBeLessThan(1000);
    }
    // More than MAX_KNOWN_PEOPLE_PER_KEY names sharing three words is refused, not scanned.
    const prefix = Array.from(
      { length: MAX_KNOWN_PEOPLE_PER_KEY + 1 },
      (_, i) => `John Smith Jr ${i}`,
    );
    expect(() => scrub("x", prefix)).toThrow(RangeError);
    expect(scrub("john smith jr 3 said", prefix.slice(0, MAX_KNOWN_PEOPLE_PER_KEY))).toBe(
      "[person] said",
    );
  });

  describe("short or common-word logins match only in person positions (S2)", () => {
    const logins = ["go", "api", "dev", "test", "main", "pat", "Mark Brown"];
    it("decides by the dictionary and a two-letter floor only (fix round 2)", () => {
      for (const strong of [
        "alice",
        "octocat2",
        "bob-the-builder",
        "李雷",
        "Alice Smith",
        "zoë",
        "john",
        "eric",
        "anna",
        "bob",
        "dana",
        "Juan Pérez",
        "Kate Moss",
        "Moss",
      ]) {
        expect(matchesAsBareWord(strong), strong).toBe(true);
      }
      for (const w of [
        "go",
        "api",
        "dev",
        "test",
        "main",
        "pat",
        "Li",
        "al",
        "Mark",
        "Brown",
        "admin",
      ]) {
        expect(matchesAsBareWord(w), w).toBe(false);
      }
    });
    table(
      [
        {
          name: "ordinary words stay",
          input: "Run on main branch, call the api from go code; test and dev too",
          expected: "Run on main branch, call the api from go code; test and dev too",
        },
        {
          name: "after a cue",
          input: "thanks go and cc api",
          expected: "thanks [person] and cc [person]",
        },
        {
          name: "before a speech verb",
          input: "dev said no; main agreed",
          expected: "[person] said no; [person] agreed",
        },
        { name: "as a handle", input: "ping @test", expected: "ping [user]" },
        { name: "in a trailer", input: "Reviewed-by: pat", expected: "Reviewed-by: [person]" },
        { name: "possessive after a cue", input: "thanks pat's", expected: "thanks [person]" },
        {
          name: "a full display name is always matched",
          input: "Mark Brown merged it",
          expected: "[person] merged it",
        },
        {
          name: "its common-word tokens are not",
          input: "Mark the field brown",
          expected: "Mark the field brown",
        },
        {
          name: "its tokens in person positions are",
          input: "cc Mark; Brown said so",
          expected: "cc [person]; [person] said so",
        },
        {
          name: "weak names in person positions inside inline code (fix round 3)",
          input: "run `thanks go` and `cc api`",
          expected: "run `thanks [person]` and `cc [person]`",
        },
        {
          name: "lower-case parts of a display name",
          input: "mark brown merged; brown said so",
          expected: "[person] merged; [person] said so",
        },
      ],
      logins,
    );
  });

  it("indexes every display-name part, trimmed of punctuation, with hyphen sub-parts (fix round 4)", () => {
    const people = [
      "Smith, Alice",
      "Bea Jones, PhD",
      'Carl "Cal" Rivers',
      "Dana 'Dee' Brooks",
      "Erin Smith-Jones",
      "A B C D E F G H Zed",
    ];
    const cases: [string, string][] = [
      ["Smith fixed it", "[person] fixed it"],
      ["smith, alice fixed it", "[person] fixed it"],
      ["Jones fixed it; PhD stays", "[person] fixed it; PhD stays"],
      ["Cal fixed it", "[person] fixed it"],
      ["Dee fixed it", "[person] fixed it"],
      ["Smith-Jones fixed it", "[person] fixed it"],
      ["Jones and Smith fixed it", "[person] and [person] fixed it"],
      ["Zed fixed it", "[person] fixed it"],
      ["Rivers fixed it", "[person] fixed it"],
      // Login words stay whole: no `the` from `bob-the-builder`.
      ["the builder fixed it", "the builder fixed it"],
    ];
    for (const [input, expected] of cases) {
      expect(scrub(input, [...people, "bob-the-builder"]), input).toBe(expected);
    }
  });

  it("stays fast when 50 000 names share a first word and the text repeats it (fix round 4)", () => {
    const names = Array.from({ length: MAX_KNOWN_PEOPLE }, (_, i) => `Shared Last${i}`);
    const text = "Shared ".repeat(280);
    const started = performance.now();
    // `Shared` alone is a part of every name, so every occurrence is a person.
    expect(scrub(text, names).trim()).toBe(Array.from({ length: 280 }, () => "[person]").join(" "));
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it("matches names with punctuation literally", () => {
    expect(scrub("a.b+c (d) said hi", ["a.b+c (d)"])).toBe("[person] said hi");
    expect(scrub("aXb+c said hi", ["a.b+c (d)"])).toBe("aXb+c said hi");
    expect(scrub("J. R. R. Tolkien wrote it", ["J. R. R. Tolkien"])).toBe("[person] wrote it");
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
    {
      name: "not a CamelCase class before a plural-noun verb (S3)",
      input: "HttpClient requests are retried",
      expected: "HttpClient requests are retried",
    },
    {
      name: "not a CamelCase class before a speech verb (S3)",
      input: "HttpClient said no",
      expected: "HttpClient said no",
    },
    {
      name: "not a class before 'notes' (S3)",
      input: "Logger notes the request id",
      expected: "Logger notes the request id",
    },
    {
      name: "not a tool before 'wants' (S3)",
      input: "Prettier wants a trailing comma",
      expected: "Prettier wants a trailing comma",
    },
    {
      name: "not a library after 'according to' (S3)",
      input: "according to Drizzle docs",
      expected: "according to Drizzle docs",
    },
    {
      name: "not inside inline code (S3)",
      input: "run `thanks Carol` verbatim",
      expected: "run `thanks Carol` verbatim",
    },
    {
      name: "a listed person inside inline code is still scrubbed (fix round 2)",
      input: "run `thanks Alice Smith` verbatim",
      expected: "run `thanks [person]` verbatim",
    },
    {
      name: "no cut after a cue: CamelCase (fix round 2)",
      input: "according to HttpClient docs",
      expected: "according to [person] docs",
    },
    { name: "no cut after thanks", input: "thanks DeShawn", expected: "thanks [person]" },
    { name: "no cut after cc", input: "cc McKenzie", expected: "cc [person]" },
    {
      name: "no cut after an honorific",
      input: "Dr. DeAndre Jones agreed",
      expected: "Dr. [person] agreed",
    },
    {
      name: "a hyphenated name before a speech verb",
      input: "Jean-Luc said no",
      expected: "[person] said no",
    },
    {
      name: "a hyphenated name after thanks",
      input: "thanks Jean-Luc",
      expected: "thanks [person]",
    },
    {
      name: "apostrophe name after thanks (fix round 3)",
      input: "thanks O'Brien",
      expected: "thanks [person]",
    },
    {
      name: "apostrophe name after an honorific",
      input: "Mr. O'Neil agreed",
      expected: "Mr. [person] agreed",
    },
    { name: "D'Angelo after thanks", input: "thanks D'Angelo", expected: "thanks [person]" },
    {
      name: "apostrophe name before a speech verb",
      input: "O'Brien said no",
      expected: "[person] said no",
    },
    {
      name: "De'Andre before a speech verb",
      input: "De'Andre said yes",
      expected: "[person] said yes",
    },
    {
      name: "Mc prefix before a speech verb",
      input: "McDonald said so",
      expected: "[person] said so",
    },
    {
      name: "De prefix before a speech verb",
      input: "DeShawn agreed",
      expected: "[person] agreed",
    },
    {
      name: "a plural noun after a name is not a speech verb (documented)",
      input: "Alice Smith notes the id",
      expected: "[person] notes the id",
    },
    {
      name: "not a plural noun after a name",
      input: "Grace comments on every PR",
      expected: "Grace comments on every PR",
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
      name: "CamelCase identifiers before verbs (S3)",
      input: "RetryPolicy decided; UserService replied",
      expected: "RetryPolicy decided; UserService replied",
    },
    {
      name: "a class in backticks after a cue (S3)",
      input: "according to `Config` it is fine",
      expected: "according to `Config` it is fine",
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
  // Any login that is not a dictionary word and longer than two characters, short ones
  // included (fix round 2: `john`, `bob` must not survive bare).
  const login = fc
    .oneof(
      fc.stringMatching(/^[a-z0-9][a-z0-9-]{1,20}[a-z0-9]$/),
      fc.stringMatching(/^[a-z]{3,4}$/),
    )
    .filter((s) => !s.includes("--") && matchesAsBareWord(s));
  const filler = fc.stringMatching(/^[ \p{L}\p{N}.,;:!?()'"-]{0,30}$/u);

  const placeholders = Object.values(PII_PLACEHOLDER).join("");

  it("in any case, with punctuation around and zero-width characters inside", () => {
    fc.assert(
      fc.property(login, filler, filler, fc.boolean(), (name, before, after, upper) => {
        // The name must not already be part of the filler or of a placeholder, or `includes`
        // would see it for reasons unrelated to the scrub.
        fc.pre(!`${before}${after}${placeholders}`.normalize("NFKC").toLowerCase().includes(name));
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
