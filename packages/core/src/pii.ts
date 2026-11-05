/**
 * Personal identifiers out of project-memory text (P8-1, ADR 0036 §2). Memory entries are
 * derived from PR content and reviewer text, quoted into prompts and exported, and they outlive
 * the people they mention; so every entry text passes through here before it is stored. Pure
 * and deterministic: the same text and people list always give the same result.
 *
 * What is replaced, by a fixed placeholder per class, and in this order of precedence:
 *   1. git trailers (`Co-authored-by: …`): the whole value           → [person]
 *   2. email addresses (plain, Unicode, `%40`, `[at]`/`(at)`/`{at}`,
 *      "at … dot …", `Name <addr>`)                                   → [email] (+ [person])
 *   3. userinfo in URLs (`https://user:pw@host`)                      → [user]
 *   4. `@handles`, except npm scopes, decorators and a tag allow-list → [user]
 *   5. the known people the caller passes (logins and display names)  → [person]
 *   6. names after honorifics or attribution cues, or before speech verbs → [person]
 *   7. phone numbers (9–15 digits with separators or a leading `+`)   → [phone]
 *   8. IPv4 addresses                                                  → [address]
 *
 * Matching happens on a canonical copy (NFKC, invisible and format characters removed, a few
 * Cyrillic and Greek look-alikes folded to Latin), so "al<U+200B>ice", full-width letters and a
 * Cyrillic "а" in "аlice"
 * all match "alice". The output is the canonical text with the matches replaced, which is also
 * what a prompt should receive: no hidden characters. What this cannot do (unlisted names in
 * neutral sentences, scripts without letter case, "the CTO") is written down in the ADR.
 *
 * Every pattern is bounded: literal alternations, bounded quantifiers, lookarounds that read one
 * character. Nothing here backtracks across the text.
 */

export type PiiClass = "person" | "email" | "handle" | "phone" | "address";

export const PII_PLACEHOLDER: Readonly<Record<PiiClass, string>> = Object.freeze({
  person: "[person]",
  email: "[email]",
  handle: "[user]",
  phone: "[phone]",
  address: "[address]",
});

export type ScrubReport = Readonly<Record<PiiClass, number>>;

export interface ScrubResult {
  readonly text: string;
  readonly replaced: ScrubReport;
  readonly total: number;
}

export interface ScrubOptions {
  /**
   * Logins and display names to remove wherever they appear as a word. Entries shorter than two
   * characters or longer than `MAX_KNOWN_PERSON_LENGTH`, and entries past `MAX_KNOWN_PEOPLE`,
   * are ignored.
   */
  readonly people?: readonly string[];
}

/** Longest text scrubbed in one call; a memory entry is far shorter (core `memory.ts`). */
export const MAX_SCRUB_INPUT_LENGTH = 16_384;
export const MAX_KNOWN_PEOPLE = 2000;
export const MAX_KNOWN_PERSON_LENGTH = 100;
/** A display-name token shorter than this ("Li", "Al") is too common a word to remove alone. */
const MIN_NAME_TOKEN_LENGTH = 3;

// --- Canonical form -------------------------------------------------------------------------

/** Default-ignorable and format characters: zero-width, joiners, soft hyphen, bidi, tags. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|\p{Cf}/gu;

/**
 * Look-alikes folded one-to-one for matching (never changes the stored text's length: every
 * entry is a single UTF-16 unit on both sides). Cyrillic and Greek letters that are drawn like
 * Latin ones, plus the dotless i.
 */
const LOOKALIKES: ReadonlyMap<string, string> = new Map(
  Object.entries({
    // Cyrillic
    а: "a",
    е: "e",
    о: "o",
    р: "p",
    с: "c",
    у: "y",
    х: "x",
    і: "i",
    ј: "j",
    ѕ: "s",
    ԁ: "d",
    һ: "h",
    ԛ: "q",
    ԝ: "w",
    ѵ: "v",
    ё: "e",
    А: "A",
    В: "B",
    Е: "E",
    К: "K",
    М: "M",
    Н: "H",
    О: "O",
    Р: "P",
    С: "C",
    Т: "T",
    У: "Y",
    Х: "X",
    І: "I",
    Ј: "J",
    Ѕ: "S",
    Ԁ: "D",
    Һ: "H",
    Ԛ: "Q",
    Ԝ: "W",
    Ѵ: "V",
    // Greek
    α: "a",
    ο: "o",
    ν: "v",
    ι: "i",
    κ: "k",
    ρ: "p",
    τ: "t",
    υ: "u",
    χ: "x",
    Α: "A",
    Β: "B",
    Ε: "E",
    Ζ: "Z",
    Η: "H",
    Ι: "I",
    Κ: "K",
    Μ: "M",
    Ν: "N",
    Ο: "O",
    Ρ: "P",
    Τ: "T",
    Υ: "Y",
    Χ: "X",
    ı: "i",
  }),
);

const canonical = (text: string): string => text.normalize("NFKC").replace(INVISIBLE, "");

const foldLookalikes = (text: string): string => {
  let out = "";
  for (const ch of text) out += LOOKALIKES.get(ch) ?? ch;
  return out;
};

// --- Patterns -------------------------------------------------------------------------------

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A literal alternation spelled case-insensitively by hand. The `i` flag is not used with the
 * name patterns: under `u` it folds `\p{Lu}` and `\p{Ll}` too, so a capitalised-word rule
 * would match any word.
 */
const anyCase = (alternation: string): string =>
  Array.from(alternation, (ch) => {
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    return lower === upper ? ch : `[${lower}${upper}]`;
  }).join("");

interface Pattern {
  readonly kind: PiiClass;
  /** Sticky-free global regex with the `d` flag, so group offsets are available. */
  readonly regex: RegExp;
  /** The capture group whose span is replaced (0: the whole match). */
  readonly group?: number;
  /** Extra check on the match; false keeps the text. */
  readonly keep?: (match: RegExpExecArray) => boolean;
}

const LETTER_OR_DIGIT = "\\p{L}\\p{N}";
/** Not inside a word or identifier: letters, digits and `_` on either side. */
const NOT_BEFORE_WORD = `(?<![${LETTER_OR_DIGIT}_])`;
const NOT_AFTER_WORD = `(?![${LETTER_OR_DIGIT}_])`;
/** A capitalised word: an upper-case letter, a lower-case letter, then letters, apostrophes, hyphens. */
const CAPITALISED = "\\p{Lu}\\p{Ll}[\\p{L}'’-]{0,40}";
/** One to three capitalised words. */
const NAME = `${CAPITALISED}(?:[ \\t]+${CAPITALISED}){0,2}`;
const EMAIL_LOCAL = `[${LETTER_OR_DIGIT}._%+'-]{1,64}`;
const EMAIL_DOMAIN = `[${LETTER_OR_DIGIT}-]{1,63}`;
const EMAIL_TLD = "\\p{L}{2,63}";

const TRAILERS =
  "co-authored-by|signed-off-by|reviewed-by|acked-by|tested-by|reported-by|suggested-by|authored-by|helped-by|mentored-by";
const HONORIFICS = "mr|mrs|ms|mx|dr|prof|sir|madam|herr|frau|mme|mlle|sr|sra|señor|señora";
const CUES =
  "thanks|thank you|thx|cc|/cc|ping|paging|kudos to|according to|h/t|credit to|courtesy of|reviewed by|written by|authored by|reported by|suggested by|requested by|approved by|discussed with|talked to|spoke with|paired with|assigned to|owned by|maintained by";
const SPEECH_VERBS =
  "said|says|wrote|writes|asked|asks|suggested|suggests|mentioned|mentions|pointed out|requested|requests|approved|approves|reviewed|reviews|noted|notes|agreed|agrees|confirmed|confirms|prefers|preferred|wants|wanted|thinks|thought|explained|explains|replied|replies|commented|comments|recommended|recommends|decided|decides|insisted|insists|proposed|proposes|merged|argued|argues";

/**
 * Capitalised words that start sentences or name groups, products and roles, never a person.
 * A name match that contains one of them is kept as text.
 */
const STOP_WORDS: ReadonlySet<string> = new Set(
  `
  the this that these those it its we they he she you i our their his her your my a an and or
  but if so as everyone someone anyone nobody everybody somebody anybody people team teams
  management product design engineering security legal support ops qa backend frontend platform
  infra data sales rocky github gitlab postgres postgresql redis node react vite typescript
  javascript python java rust docker kubernetes linux windows macos chrome firefox safari
  stripe paddle fly cloudflare dependabot renovate bot ci cd reviewer reviewers author authors
  maintainer maintainers owner owners admin admins user users customer customers client clients
  member members contributor contributors committer developer developers monday tuesday
  wednesday thursday friday saturday sunday january february march april may june july august
  september october november december today tomorrow yesterday mr mrs ms mx dr prof sir madam
  herr frau mme mlle sr sra señor señora
  `
    .split(/\s+/u)
    .filter((w) => w.length > 0),
);

const tokensOf = (name: string): string[] => name.toLowerCase().split(/[ \t]+/);
const noStopWord = (name: string): boolean => !tokensOf(name).some((t) => STOP_WORDS.has(t));

const DIGITS = /\d/g;
const DATE_LIKE = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/;

const PATTERNS: readonly Pattern[] = [
  {
    kind: "person",
    regex: new RegExp(`^[ \\t]*(?:${TRAILERS})[ \\t]*:[ \\t]*([^\\n]{1,200}?)[ \\t]*$`, "gimud"),
    group: 1,
  },
  // `Name <addr@host>`: the name is replaced here, the address by the email patterns below.
  {
    kind: "person",
    regex: new RegExp(`${NOT_BEFORE_WORD}(${NAME})[ \\t]*<${EMAIL_LOCAL}@`, "gud"),
    group: 1,
    keep: (m) => noStopWord(m[1] ?? ""),
  },
  {
    kind: "email",
    regex: new RegExp(
      `${EMAIL_LOCAL}@(?:${EMAIL_DOMAIN}\\.){1,8}${EMAIL_TLD}${NOT_AFTER_WORD}`,
      "gud",
    ),
  },
  {
    kind: "email",
    regex: new RegExp(
      `${EMAIL_LOCAL}%40(?:${EMAIL_DOMAIN}(?:\\.|%2[Ee])){1,8}${EMAIL_TLD}${NOT_AFTER_WORD}`,
      "gud",
    ),
  },
  // `jane [at] example [dot] com`, `jane(at)example.com`: a bracketed "at", dots spelled or real.
  {
    kind: "email",
    regex: new RegExp(
      `${EMAIL_LOCAL}[ \\t]*(?:\\[at\\]|\\(at\\)|\\{at\\})[ \\t]*(?:${EMAIL_DOMAIN}[ \\t]*(?:\\[dot\\]|\\(dot\\)|\\{dot\\}|\\.)[ \\t]*){1,8}${EMAIL_TLD}${NOT_AFTER_WORD}`,
      "giud",
    ),
  },
  // `jane at example dot com`: a spelled "at" needs a spelled "dot" ("look at example.com" stays).
  {
    kind: "email",
    regex: new RegExp(
      `${NOT_BEFORE_WORD}${EMAIL_LOCAL}[ \\t]+at[ \\t]+(?:${EMAIL_DOMAIN}[ \\t]+dot[ \\t]+){1,8}${EMAIL_TLD}${NOT_AFTER_WORD}`,
      "giud",
    ),
  },
  {
    kind: "handle",
    regex: /(?<=\b[a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/@]{1,256})@/dgiu,
    group: 1,
  },
  {
    kind: "handle",
    regex: new RegExp(
      `${NOT_BEFORE_WORD}@([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)(?![${LETTER_OR_DIGIT}_/(-])`,
      "giud",
    ),
    keep: (m) => !CODE_AT_WORDS.has((m[1] ?? "").toLowerCase()),
  },
  // Known people are inserted here (index KNOWN_PEOPLE_AT) per call.
  {
    kind: "person",
    regex: new RegExp(`\\b(?:${anyCase(HONORIFICS)})\\.?[ \\t]+(${NAME})`, "gud"),
    group: 1,
    keep: (m) => noStopWord(m[1] ?? ""),
  },
  {
    kind: "person",
    regex: new RegExp(
      `${NOT_BEFORE_WORD}(?:${anyCase(CUES)})(?:[ \\t]+[tT][oO])?[ \\t]+(${NAME})`,
      "gud",
    ),
    group: 1,
    keep: (m) => noStopWord(m[1] ?? ""),
  },
  {
    kind: "person",
    regex: new RegExp(
      `${NOT_BEFORE_WORD}(${NAME})[ \\t]+(?:${SPEECH_VERBS})${NOT_AFTER_WORD}`,
      "gud",
    ),
    group: 1,
    keep: (m) => noStopWord(m[1] ?? ""),
  },
  {
    kind: "address",
    regex:
      /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/dg,
  },
  {
    kind: "phone",
    regex:
      /(?<![\p{L}\p{N}#/._+-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?|\d{2,4}[ .-])\d{2,4}[ .-]?\d{2,4}(?:[ .-]?\d{2,4})?(?![\p{L}\p{N}/._-])/dgu,
    keep: (m) => {
      const text = m[0] ?? "";
      const digits = (text.match(DIGITS) ?? []).length;
      return digits >= 9 && digits <= 15 && !DATE_LIKE.test(text);
    },
  },
];
const KNOWN_PEOPLE_AT = 8;

/**
 * `@words` that are code, not people: JSDoc and TSDoc tags, CSS at-rules, Java, Kotlin, C#,
 * Python and Angular annotations, TypeScript directives. An unlisted tag is scrubbed, which is
 * the safe failure.
 */
const CODE_AT_WORDS: ReadonlySet<string> = new Set(
  `
  abstract access alias async augments author borrows callback class classdesc constant const
  constructor constructs copyright default defaultvalue deprecated description desc enum event
  example exports extends external host file fileoverview overview fires emits function func
  method generator global hideconstructor ignore implements inheritdoc inner instance interface
  internal kind lends license link linkcode linkplain listens member var memberof mixes mixin
  module name namespace override package param arg argument private property prop protected
  public readonly remarks requires returns return see since static summary template this throws
  exception todo tutorial type typedef typeparam variation version virtual yields yield
  experimental beta alpha sealed label jsx ts-ignore ts-expect-error ts-nocheck ts-check
  eslint-disable eslint-disable-next-line eslint-disable-line eslint-enable prettier-ignore
  vitest-environment jest-environment jsximportsource flow media import charset font-face
  keyframes supports page layer container counter-style font-feature-values scope
  starting-style apply tailwind use forward include extend each if else for while at-root debug
  warn error suppresswarnings functionalinterface safevarargs nullable nonnull notnull inject
  injectable component input output pipe directive hostlistener viewchild service controller
  get post put patch delete body query entity column primarycolumn primarygeneratedcolumn
  onetomany manytoone manytomany onetoone joincolumn test before after beforeeach aftereach
  beforeall afterall autowired bean configuration transactional restcontroller requestmapping
  getmapping postmapping id unique index relation map updatedat createdat model dataclass
  staticmethod classmethod pytest mock fixture parametrize decorator jvmstatic composable
  preview serializable obsolete attribute html layout rendermode code foreach switch using
  section await
  `
    .split(/\s+/u)
    .filter((w) => w.length > 0),
);

// --- Known people ---------------------------------------------------------------------------

const foldPerson = (name: string): string => foldLookalikes(canonical(name)).trim();

/**
 * Two patterns for the caller's people: logins and whole display names, case-insensitively;
 * the tokens of a display name as written (so a capitalised surname is caught and the same
 * word in lower case is not). Possessives are part of the match.
 */
const knownPeoplePatterns = (people: readonly string[]): Pattern[] => {
  const insensitive = new Set<string>();
  const sensitive = new Set<string>();
  for (const raw of people.slice(0, MAX_KNOWN_PEOPLE)) {
    if (typeof raw !== "string") continue;
    const name = foldPerson(raw).replace(/\s+/g, " ");
    if (name.length < 2 || name.length > MAX_KNOWN_PERSON_LENGTH) continue;
    insensitive.add(name.toLowerCase());
    const tokens = name.split(" ");
    if (tokens.length === 1) continue;
    for (const token of tokens) {
      if (Array.from(token).length >= MIN_NAME_TOKEN_LENGTH) sensitive.add(token);
    }
  }
  const alternation = (names: Set<string>): string =>
    [...names]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join("|");
  const pattern = (names: Set<string>, flags: string): Pattern[] =>
    names.size === 0
      ? []
      : [
          {
            kind: "person",
            regex: new RegExp(
              `${NOT_BEFORE_WORD}(?:${alternation(names)})(?:['’]s)?${NOT_AFTER_WORD}`,
              flags,
            ),
          },
        ];
  return [...pattern(insensitive, "giud"), ...pattern(sensitive, "gud")];
};

// --- Matching and assembly ------------------------------------------------------------------

interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: PiiClass;
  readonly priority: number;
}

const spansOf = (folded: string, pattern: Pattern, priority: number): Span[] => {
  const spans: Span[] = [];
  const { regex } = pattern;
  regex.lastIndex = 0;
  for (let match = regex.exec(folded); match !== null; match = regex.exec(folded)) {
    if (match[0].length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    if (pattern.keep !== undefined && !pattern.keep(match)) {
      // Retry from the next position: a rejected span may hide a shorter match inside it
      // ("The Alice Smith said" → "Alice Smith said").
      regex.lastIndex = match.index + 1;
      continue;
    }
    const span = match.indices?.[pattern.group ?? 0];
    if (span === undefined) continue;
    const [start, end] = span;
    if (end > start) spans.push({ start, end, kind: pattern.kind, priority });
  }
  return spans;
};

/** Earliest start wins; at the same start the earlier pattern, then the longer span. */
const resolve = (spans: Span[]): Span[] => {
  spans.sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end);
  const kept: Span[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    kept.push(span);
    cursor = span.end;
  }
  return kept;
};

const emptyReport = (): Record<PiiClass, number> => ({
  person: 0,
  email: 0,
  handle: 0,
  phone: 0,
  address: 0,
});

/**
 * Replaces personal identifiers in `text` (see the module comment). Throws `RangeError` for a
 * text longer than `MAX_SCRUB_INPUT_LENGTH`: callers bound their input first.
 */
export const scrubPersonalIdentifiers = (text: string, options: ScrubOptions = {}): ScrubResult => {
  if (typeof text !== "string") throw new TypeError("scrub: text must be a string");
  if (text.length > MAX_SCRUB_INPUT_LENGTH) {
    throw new RangeError(`scrub: text longer than ${MAX_SCRUB_INPUT_LENGTH} characters`);
  }
  const clean = canonical(text);
  const folded = foldLookalikes(clean);
  const patterns = [
    ...PATTERNS.slice(0, KNOWN_PEOPLE_AT),
    ...knownPeoplePatterns(options.people ?? []),
    ...PATTERNS.slice(KNOWN_PEOPLE_AT),
  ];
  const spans = resolve(patterns.flatMap((pattern, index) => spansOf(folded, pattern, index)));
  const replaced = emptyReport();
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += clean.slice(cursor, span.start) + PII_PLACEHOLDER[span.kind];
    // `[person](…)` would read as a markdown link: keep a parenthesis off the placeholder.
    if (clean[span.end] === "(") out += " ";
    cursor = span.end;
    replaced[span.kind] += 1;
  }
  out += clean.slice(cursor);
  const total = spans.length;
  return { text: out, replaced, total };
};
