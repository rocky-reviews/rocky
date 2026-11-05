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
   * Logins and display names to remove, case-insensitively: wherever they appear as a word
   * when `matchesAsBareWord`, else only in person positions. Entries shorter than two
   * characters or longer than `MAX_KNOWN_PERSON_LENGTH` are ignored; more than
   * `MAX_KNOWN_PEOPLE` distinct names is a `RangeError`.
   */
  readonly people?: readonly string[];
}

/** Longest text scrubbed in one call; a memory entry is far shorter (core `memory.ts`). */
export const MAX_SCRUB_INPUT_LENGTH = 16_384;
/**
 * Distinct people (after folding and case-folding) one call accepts; more is a `RangeError`,
 * never a silently shortened list. People are matched by word lookup, not by a compiled
 * pattern, so the cost is linear in the list: 50 000 five-word display names index and scrub a
 * 300-character text in well under a second (the test measures it).
 */
export const MAX_KNOWN_PEOPLE = 50_000;
export const MAX_KNOWN_PERSON_LENGTH = 100;

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
/** `@Decorator` alone on its line (the usual decorator syntax without a call). */
const OWN_LINE_BEFORE = /(?:^|\n)[ \t]*$/u;
const OWN_LINE_AFTER = /^[ \t]*(?:\n|$)/u;
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
  readonly keep?: (match: RegExpExecArray, text: string) => boolean;
}

const LETTER_OR_DIGIT = "\\p{L}\\p{N}";
/** Not inside a word or identifier: letters, digits and `_` on either side. */
const NOT_BEFORE_WORD = `(?<![${LETTER_OR_DIGIT}_])`;
const NOT_AFTER_WORD = `(?![${LETTER_OR_DIGIT}_])`;
/** A match never ends inside a word: `thanks DeShawn` is all of `DeShawn` or nothing. */
const WORD_END = `(?![${LETTER_OR_DIGIT}_'’-])`;
/**
 * A capitalised word after a cue or an honorific: an upper-case letter, a lower-case letter,
 * then any letters (`DeShawn`, `McKenzie`, `Jean-Luc`); the stop list keeps products out.
 */
const CAPITALISED = "\\p{Lu}(?:['’]\\p{Lu})?\\p{Ll}[\\p{L}'’-]{0,40}";
/**
 * A capitalised word before a speech verb: lower-case letters after the capital, with the
 * usual name prefixes (`McKenzie`, `DeShawn`, `FitzGerald`), apostrophe parts (`O'Brien`,
 * `De'Andre`) and hyphenated parts (`Jean-Luc`), so a CamelCase identifier (`HttpClient said`)
 * is never a name.
 */
const NAME_PREFIX = "(?:(?:Mc|Mac|Fitz|De|Di|Da|Du|La|Le|Van|Von)(?=\\p{Lu}))?";
const CAPITALISED_PLAIN = `${NAME_PREFIX}\\p{Lu}(?:\\p{Ll}{1,40}|['’]\\p{Lu}\\p{Ll}{1,40})(?:['’]\\p{Lu}?\\p{Ll}{1,40}){0,2}(?:-\\p{Lu}?\\p{Ll}{1,40}){0,3}`;
/** One to three capitalised words, ending at a word boundary. */
const NAME = `${CAPITALISED}(?:[ \\t]+${CAPITALISED}){0,2}${WORD_END}`;
const NAME_PLAIN = `${CAPITALISED_PLAIN}(?:[ \\t]+${CAPITALISED_PLAIN}){0,2}${WORD_END}`;
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
    // cannot contain a dot); not a listed tag or decorator; not a CamelCase word alone on its
    // line (decorator syntax). `@JohnSmith about it` is a person. Applies inside code spans too.
    regex: new RegExp(
      `${NOT_BEFORE_WORD}@([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)(?![${LETTER_OR_DIGIT}_/(-]|\\.[\\p{L}_])`,
      "giud",
    ),
    keep: (m, text) => {
      const handle = m[1] ?? "";
      if (CODE_AT_WORDS.has(handle.toLowerCase())) return false;
      if (!CAMEL_CASE.test(handle)) return true;
      const before = text.slice(0, m.index);
      const after = text.slice(m.index + m[0].length);
      return !(OWN_LINE_BEFORE.test(before) && OWN_LINE_AFTER.test(after));
    },
  },
  // Known people take priority slot KNOWN_PEOPLE_AT here (`knownPeopleSpans`, no pattern).
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
      `${NOT_BEFORE_WORD}(${NAME_PLAIN})[ \\t]+(?:${SPEECH_VERBS})${NOT_AFTER_WORD}`,
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
    hostbinding contentchild contentchildren viewchildren ngmodule optional skipself injectiontoken
  requestbody pathvariable requestparam responsebody exceptionhandler valid validated sneakythrows
  getter setter builder allargsconstructor noargsconstructor slf4j jsonproperty jsonignore
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
  phd msc bsc esq jnr snr
  `
    .split(/\s+/u)
    .filter((w) => w.length > 0),
);

const ASCII_WORD = /^[a-z]+$/i;

/**
 * Whether a person's name (or a token of a display name) is scrubbed wherever it appears as a
 * word. Only two things make it "weak" (scrubbed in person positions only): it is an ASCII word
 * in the common-words dictionary (`go`, `main`, `Mark`), or it is at most two letters (`Li`,
 * `Al`). Everything else is a person wherever it appears: `john`, `eric`, `bob`, `octocat2`,
 * `bob-the-builder`, `李雷`, and every multi-word name as a whole.
 */
export const matchesAsBareWord = (name: string): boolean => {
  if (/[\s]/u.test(name)) return true;
  if (!ASCII_WORD.test(name)) return true;
  const lower = name.toLowerCase();
  return name.length > 2 && !COMMON_WORDS.has(lower) && !STOP_WORDS.has(lower);
};

/** Punctuation around a display-name part (`Smith,`, `"Ally"`, `(d)`), trimmed before indexing. */
const PART_EDGE = /^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu;
const WORD = /[\p{L}\p{N}_]+/gu;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * A known person as the token matcher sees it: the words of the name in lower case, the text
 * between them (whitespace collapsed; `-` in `bob-the-builder`), and any non-word text around
 * (`(d)` in `a.b+c (d)`).
 */
interface KnownPerson {
  readonly words: readonly string[];
  readonly gaps: readonly string[];
  readonly lead: string;
  readonly trail: string;
  readonly weak: boolean;
}

/**
 * Known people by their first two words (one for a single-word name), longer names first, so
 * the longest match wins. Two words, so a text full of a first word 50 000 names share does
 * not scan 50 000 candidates per occurrence.
 */
type KnownPeopleIndex = ReadonlyMap<string, readonly KnownPerson[]>;
const indexKey = (words: readonly string[]): string =>
  words.length === 1 ? (words[0] ?? "") : `${words[0]} ${words[1]}`;

const collapse = (gap: string): string => gap.replace(/[ \t]+/gu, " ");

const personOf = (name: string): KnownPerson | null => {
  const words: string[] = [];
  const gaps: string[] = [];
  let lead = "";
  let last = 0;
  for (const match of name.matchAll(WORD)) {
    if (words.length === 0) lead = name.slice(0, match.index);
    else gaps.push(collapse(name.slice(last, match.index)));
    words.push(match[0].toLowerCase());
    last = match.index + match[0].length;
  }
  if (words.length === 0) return null;
  // Weakness is judged on the words (`(d)` is the two-letter-or-less word `d`; `bob-the-builder`
  // is three words, so a whole name even though it is one login).
  return { words, gaps, lead, trail: name.slice(last), weak: !matchesAsBareWord(words.join(" ")) };
};

const keyOf = (person: KnownPerson): string =>
  `${person.lead}|${person.words.join(" ")}|${person.gaps.join("|")}|${person.trail}`;

/**
 * Indexes the caller's people: each login and whole display name, case-insensitively, and each
 * word of a display name on its own (weak when it is a dictionary word or at most two letters).
 * Linear in the list: no pattern is compiled, so a long list cannot stall or exhaust memory.
 * Throws `RangeError` past `MAX_KNOWN_PEOPLE` distinct folded names: the caller refuses the
 * entry instead of scrubbing with a shortened list.
 */
const indexPeople = (people: readonly string[]): KnownPeopleIndex => {
  const index = new Map<string, KnownPerson[]>();
  const seen = new Set<string>();
  const add = (person: KnownPerson): boolean => {
    const key = keyOf(person);
    if (seen.has(key)) return false;
    seen.add(key);
    const slot = indexKey(person.words);
    const list = index.get(slot);
    if (list === undefined) index.set(slot, [person]);
    else list.push(person);
    return true;
  };
  let distinct = 0;
  for (const raw of people) {
    if (typeof raw !== "string") continue;
    const name = foldPerson(raw).replace(/\s+/gu, " ");
    if (name.length < 2 || name.length > MAX_KNOWN_PERSON_LENGTH) continue;
    const whole = personOf(name);
    if (whole === null) continue;
    if (add(whole)) {
      distinct += 1;
      if (distinct > MAX_KNOWN_PEOPLE) {
        throw new RangeError(`scrub: more than ${MAX_KNOWN_PEOPLE} distinct people`);
      }
    }
    // Every space-separated part of a display name on its own, trimmed of punctuation (`Smith`
    // of `Smith, Alice`, `Ally` of `Alice "Ally" Smith`), and the hyphen-separated sub-parts
    // (`Smith` and `Jones` of `Alice Smith-Jones`). A login's hyphenated words are not parts:
    // `bob-the-builder` must not make `the` a person. The weak rules apply to each.
    const parts = name.split(" ");
    if (parts.length === 1) continue;
    for (const raw of parts) {
      const part = raw.replace(PART_EDGE, "");
      if (part.length === 0) continue;
      const pieces = part.includes("-") ? [part, ...part.split("-")] : [part];
      for (const piece of pieces) {
        const person = personOf(piece.replace(PART_EDGE, ""));
        if (person !== null) add(person);
      }
    }
  }
  for (const list of index.values()) list.sort((a, b) => b.words.length - a.words.length);
  return index;
};

const POSSESSIVE = /^['’]s/u;
const CUE_BEFORE = new RegExp(
  `(?:^|[^${LETTER_OR_DIGIT}_])(?:${anyCase(CUES)})(?:[ \\t]+[tT][oO])?[ \\t]+$`,
  "u",
);
const VERB_AFTER = new RegExp(`^[ \\t]+(?:${SPEECH_VERBS})${NOT_AFTER_WORD}`, "u");

/**
 * Spans of the known people in `folded`: the text is split into words once and each word is
 * looked up; a multi-word name must match word by word with the same text in between, and a
 * match must start and end at a word boundary (`aliceValidator` and `malice` are not Alice).
 * Possessives are part of the match. A weak name is kept only in a person position: after `@`
 * (the span then covers the handle), after a cue, or before a speech verb (trailers are
 * replaced whole by their own pattern). Inline code does not protect a listed person.
 */
const knownPeopleSpans = (folded: string, index: KnownPeopleIndex, priority: number): Span[] => {
  if (index.size === 0) return [];
  const spans: Span[] = [];
  const words = [...folded.matchAll(WORD)].map((m) => ({
    text: m[0].toLowerCase(),
    start: m.index,
    end: m.index + m[0].length,
  }));
  for (let i = 0; i < words.length; i++) {
    const first = words[i];
    if (first === undefined) continue;
    const second = words[i + 1];
    const candidates = [
      ...(second === undefined ? [] : (index.get(`${first.text} ${second.text}`) ?? [])),
      ...(index.get(first.text) ?? []),
    ];
    for (const person of candidates) {
      // Every word, with the same text between (whitespace collapsed).
      let ok = true;
      let lastEnd = first.end;
      for (let k = 1; k < person.words.length; k++) {
        const word = words[i + k];
        if (
          word === undefined ||
          word.text !== person.words[k] ||
          collapse(folded.slice(lastEnd, word.start)) !== person.gaps[k - 1]
        ) {
          ok = false;
          break;
        }
        lastEnd = word.end;
      }
      if (!ok) continue;
      const start = first.start - person.lead.length;
      if (start < 0 || folded.slice(start, first.start) !== person.lead) continue;
      let end = lastEnd + person.trail.length;
      if (folded.slice(lastEnd, end) !== person.trail) continue;
      // Boundaries: not inside a word on either side (after an optional possessive).
      if (start > 0 && WORD_CHAR.test(folded[start - 1] ?? "")) continue;
      const possessive = POSSESSIVE.exec(folded.slice(end, end + 2));
      if (possessive !== null) end += possessive[0].length;
      if (WORD_CHAR.test(folded[end] ?? "")) continue;
      if (person.weak) {
        if (folded[start - 1] === "@" && !WORD_CHAR.test(folded[start - 2] ?? "")) {
          spans.push({ start: start - 1, end, kind: "handle", priority });
          break;
        }
        const before = folded.slice(Math.max(0, start - 80), start);
        const after = folded.slice(end, end + 40);
        if (!CUE_BEFORE.test(before) && !VERB_AFTER.test(after)) continue;
      }
      spans.push({ start, end, kind: "person", priority });
      break;
    }
  }
  return spans;
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
    if (pattern.keep !== undefined && !pattern.keep(match, folded)) {
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
  const people = indexPeople(options.people ?? []);
  const code = codeSpans(folded);
  const spans = resolve([
    ...PATTERNS.slice(0, KNOWN_PEOPLE_AT).flatMap((pattern, index) =>
      spansOf(folded, code, pattern, index),
    ),
    ...knownPeopleSpans(folded, people, KNOWN_PEOPLE_AT),
    ...PATTERNS.slice(KNOWN_PEOPLE_AT).flatMap((pattern, index) =>
      spansOf(folded, code, pattern, KNOWN_PEOPLE_AT + 1 + index),
    ),
  ]);
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
