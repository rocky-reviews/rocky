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
   * Logins and display names to remove: wherever they appear as a word when
   * `matchesAsBareWord`, else only in person positions. Entries shorter than two characters or
   * longer than `MAX_KNOWN_PERSON_LENGTH` are ignored; more than `MAX_KNOWN_PEOPLE` distinct
   * names is a `RangeError`.
   */
  readonly people?: readonly string[];
}

/** Longest text scrubbed in one call; a memory entry is far shorter (core `memory.ts`). */
export const MAX_SCRUB_INPUT_LENGTH = 16_384;
/**
 * Distinct people (after folding and case-folding) one call accepts; more is a `RangeError`,
 * never a silently shortened list. 5 000 names scrub a 300-character text in a few
 * milliseconds (the alternation is literal, so matching is linear).
 */
export const MAX_KNOWN_PEOPLE = 5000;
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

const CAMEL_CASE = /^\p{Lu}\p{Ll}+\p{Lu}/u;
/** Inline code: heuristics (names by context, handles) do not look inside it. */
const INLINE_CODE = /`[^`\n]{1,300}`/gu;

interface Pattern {
  readonly kind: PiiClass;
  /** Heuristic: spans inside inline code (backticks) are dropped. */
  readonly skipCode?: true;
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
/**
 * A capitalised word: an upper-case letter, then lower-case letters, apostrophes and hyphens
 * only, so a CamelCase identifier (`HttpClient`) is never a name. (`McDonald` is not either;
 * listed people are matched as written.)
 */
const CAPITALISED = "\\p{Lu}\\p{Ll}[\\p{Ll}'’-]{0,40}";
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
/**
 * Verbs a person is the subject of. Forms that double as plural nouns (`requests`, `notes`,
 * `comments`, `reviews`, `mentions`, `replies`) are left out: `HttpClient requests` is code.
 */
const SPEECH_VERBS =
  "said|says|wrote|writes|asked|asks|suggested|suggests|mentioned|pointed out|requested|approved|approves|reviewed|noted|agreed|agrees|confirmed|confirms|prefers|preferred|wants|wanted|thinks|thought|explained|explains|replied|commented|recommended|recommends|decided|decides|insisted|insists|proposed|proposes|merged|argued|argues";

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
  prettier eslint vitest jest mocha webpack babel rollup esbuild turbopack playwright cypress
  storybook tailwind drizzle prisma knex sequelize fastify express koa hapi nest next nuxt
  remix svelte angular vue solid astro octokit pino winston sentry datadog grafana prometheus
  terraform ansible pulumi nginx apache caddy traefik bitbucket jira slack discord notion figma
  linear vercel netlify heroku aws azure gcp lambda kms ec2 iam rds dynamo sqs sns kafka rabbit
  nats mysql mariadb sqlite mongo mongodb elastic opensearch typesense pgvector logger client
  server router handler service module package component hook plugin adapter provider
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
    // Not followed by `/` (npm scope), `(` (decorator call) or `.letter` (`@app.route`: a login
    // cannot contain a dot); not a listed tag; not CamelCase with two humps (`@HostBinding`).
    regex: new RegExp(
      `${NOT_BEFORE_WORD}@([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)(?![${LETTER_OR_DIGIT}_/(-]|\\.[\\p{L}_])`,
      "giud",
    ),
    skipCode: true,
    keep: (m) => {
      const handle = m[1] ?? "";
      return !CODE_AT_WORDS.has(handle.toLowerCase()) && !CAMEL_CASE.test(handle);
    },
  },
  // Known people are inserted here (index KNOWN_PEOPLE_AT) per call.
  {
    kind: "person",
    regex: new RegExp(`\\b(?:${anyCase(HONORIFICS)})\\.?[ \\t]+(${NAME})`, "gud"),
    group: 1,
    skipCode: true,
    keep: (m) => noStopWord(m[1] ?? ""),
  },
  {
    kind: "person",
    regex: new RegExp(
      `${NOT_BEFORE_WORD}(?:${anyCase(CUES)})(?:[ \\t]+[tT][oO])?[ \\t]+(${NAME})`,
      "gud",
    ),
    group: 1,
    skipCode: true,
    keep: (m) => noStopWord(m[1] ?? ""),
  },
  {
    kind: "person",
    regex: new RegExp(
      `${NOT_BEFORE_WORD}(${NAME})[ \\t]+(?:${SPEECH_VERBS})${NOT_AFTER_WORD}`,
      "gud",
    ),
    group: 1,
    skipCode: true,
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
 * Logins and name tokens that are also ordinary words or too short to be anything else. Such a
 * person is scrubbed only where the text treats them as a person: after `@`, after a cue
 * (`thanks go`), before a speech verb (`go said`) or in a trailer. A bare `go` or `main` stays.
 */
const COMMON_WORDS: ReadonlySet<string> = new Set(
  `
  go api dev test main master admin root user build app web data code docs bot ops git node run
  add fix new old log key map set get put del max min sum tag tab bar foo baz dot net org com io
  mail home work time date day week year hello world team alpha beta gamma delta omega prod stage
  local cloud server client mobile backend frontend review merge branch commit push pull issue bug
  feature release deploy cache queue token auth login logout config env file path line page view
  model index table query error debug info warn trace status health metric event hook job task
  note memo draft final true false null none some any all each every first last next prev back up
  down left right open close start stop play pause send read write list item group kind type name
  value text demo sample example default public private static const let var class func lambda
  async await yield return break case switch while for loop apply call bind this self super core
  lib src dist tmp temp bin etc var opt usr sys proc dump load save edit copy move link sync async
  check verify scan clean reset retry skip done todo wip help about search filter sort order limit
  count total score rank level grade rate speed size width height color style theme dark light
  mark brown white green black grey gray rose may will bill grant hope faith joy summer april june
  august jack chase pat sunny rob art max rich frank guy jay ray roy ivy dawn eve lane cliff clay
  reed rusty sandy wade warren dean earl grace honor justice mercy victor carol hunter miles
  `
    .split(/\s+/u)
    .filter((w) => w.length > 0),
);

const ASCII_WORD = /^[a-z]+$/i;

/**
 * Whether a single-token person is scrubbed wherever it appears as a word: it has a digit or a
 * hyphen (`octocat2`, `bob-the-builder`), it is not ASCII (`李雷`), or it has at least five
 * letters and is not a common word. Multi-word names are always matched as a whole.
 */
export const matchesAsBareWord = (name: string): boolean => {
  if (/[\s]/u.test(name)) return true;
  if (!ASCII_WORD.test(name)) return true;
  return name.length >= 5 && !COMMON_WORDS.has(name.toLowerCase());
};

const alternation = (names: Iterable<string>): string =>
  [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");

/**
 * Patterns for the caller's people. Logins and whole display names match case-insensitively;
 * the tokens of a display name match as written (a capitalised surname is caught, the same word
 * in lower case is not). Possessives are part of the match. A name that `matchesAsBareWord`
 * refuses (`go`, `Mark`) is matched only after a cue or before a speech verb (trailers and
 * `@handles` are covered by their own patterns). Throws `RangeError` past `MAX_KNOWN_PEOPLE`
 * distinct names: the caller refuses the entry instead of scrubbing with a shortened list.
 */
const knownPeoplePatterns = (people: readonly string[]): Pattern[] => {
  const insensitive = new Set<string>();
  const sensitive = new Set<string>();
  const weakInsensitive = new Set<string>();
  const weakSensitive = new Set<string>();
  for (const raw of people) {
    if (typeof raw !== "string") continue;
    const name = foldPerson(raw).replace(/\s+/g, " ");
    if (name.length < 2 || name.length > MAX_KNOWN_PERSON_LENGTH) continue;
    (matchesAsBareWord(name) ? insensitive : weakInsensitive).add(name.toLowerCase());
    const tokens = name.split(" ");
    if (tokens.length === 1) continue;
    for (const token of tokens) {
      if (Array.from(token).length < MIN_NAME_TOKEN_LENGTH) continue;
      (matchesAsBareWord(token) ? sensitive : weakSensitive).add(token);
    }
  }
  const distinct = new Set([
    ...insensitive,
    ...weakInsensitive,
    ...[...sensitive, ...weakSensitive].map((t) => t.toLowerCase()),
  ]);
  if (distinct.size > MAX_KNOWN_PEOPLE) {
    throw new RangeError(`scrub: more than ${MAX_KNOWN_PEOPLE} distinct people`);
  }
  const bare = (names: Set<string>, flags: string): Pattern[] =>
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
  const inContext = (names: Set<string>, flags: string): Pattern[] =>
    names.size === 0
      ? []
      : [
          // `@go`: a listed login after `@` is a person even when the tag allow-list has the word.
          {
            kind: "handle",
            regex: new RegExp(
              `${NOT_BEFORE_WORD}@(?:${alternation(names)})${NOT_AFTER_WORD}`,
              flags,
            ),
          },
          {
            kind: "person",
            regex: new RegExp(
              `${NOT_BEFORE_WORD}(?:${anyCase(CUES)})(?:[ \\t]+[tT][oO])?[ \\t]+((?:${alternation(names)})(?:['’]s)?)${NOT_AFTER_WORD}`,
              flags,
            ),
            group: 1,
            skipCode: true,
          },
          {
            kind: "person",
            regex: new RegExp(
              `${NOT_BEFORE_WORD}((?:${alternation(names)})(?:['’]s)?)[ \\t]+(?:${SPEECH_VERBS})${NOT_AFTER_WORD}`,
              flags,
            ),
            group: 1,
            skipCode: true,
          },
        ];
  return [
    ...bare(insensitive, "giud"),
    ...bare(sensitive, "gud"),
    ...inContext(weakInsensitive, "giud"),
    ...inContext(weakSensitive, "gud"),
  ];
};

// --- Matching and assembly ------------------------------------------------------------------

interface Span {
  readonly start: number;
  readonly end: number;
  readonly kind: PiiClass;
  readonly priority: number;
}

const codeSpans = (folded: string): [number, number][] =>
  [...folded.matchAll(INLINE_CODE)].map((m) => [m.index, m.index + m[0].length]);

const insideCode = (code: readonly [number, number][], start: number, end: number): boolean =>
  code.some(([from, to]) => start < to && end > from);

const spansOf = (
  folded: string,
  code: readonly [number, number][],
  pattern: Pattern,
  priority: number,
): Span[] => {
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
    if (end <= start) continue;
    if (pattern.skipCode === true && insideCode(code, start, end)) {
      regex.lastIndex = match.index + 1;
      continue;
    }
    spans.push({ start, end, kind: pattern.kind, priority });
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
 * text longer than `MAX_SCRUB_INPUT_LENGTH` or more than `MAX_KNOWN_PEOPLE` distinct people:
 * callers bound their input first and refuse rather than scrub with less.
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
  const code = codeSpans(folded);
  const spans = resolve(
    patterns.flatMap((pattern, index) => spansOf(folded, code, pattern, index)),
  );
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
