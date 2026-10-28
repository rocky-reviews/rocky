/**
 * A small syntax highlighter for the diff view (P6-3, ADR 0023): keywords, strings, comments and
 * numbers, like the POC. It returns tokens, never HTML; the view renders each one as a React
 * text child, so code in a diff stays text whatever it contains.
 *
 * One line at a time (a virtualised row is rendered on its own), in a single linear pass with no
 * regular expressions over the line, so hostile input cannot make it backtrack. A string or block
 * comment left open runs to the end of the line; multi-line state is not tracked.
 */

export type TokenKind = "kw" | "str" | "com" | "num" | "plain";
export type Token = { readonly kind: TokenKind; readonly text: string };

/** `js` also covers TypeScript, JSX and JSON; `hash` is any language with `#` line comments. */
export type Language = "js" | "sql" | "hash" | "plain";

/** Characters highlighted per line; the rest of a longer (often minified) line is plain. */
export const MAX_HIGHLIGHT_CHARS = 2000;

const EXTENSIONS: Readonly<Record<string, Language>> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  json: "js",
  sql: "sql",
  yaml: "hash",
  yml: "hash",
  toml: "hash",
  sh: "hash",
  bash: "hash",
  py: "hash",
  rb: "hash",
};

export const languageFor = (path: string): Language => {
  const dot = path.lastIndexOf(".");
  if (dot === -1 || path.indexOf("/", dot) !== -1) return "plain";
  return EXTENSIONS[path.slice(dot + 1).toLowerCase()] ?? "plain";
};

const words = (list: string): ReadonlySet<string> => new Set(list.split(" "));

const JS_KEYWORDS = words(
  "import from export default const let var async await function return if else for while do " +
    "switch case break continue throw try catch finally new typeof instanceof in of class " +
    "extends implements interface type enum public private protected readonly static as " +
    "satisfies void delete yield this super null undefined true false",
);

/** Upper-cased; SQL keywords are matched in any case. */
const SQL_KEYWORDS = words(
  "SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX ON ALTER DROP ADD " +
    "COLUMN ENABLE DISABLE ROW LEVEL SECURITY POLICY USING WITH CHECK PRIMARY KEY FOREIGN " +
    "REFERENCES DEFAULT NOT NULL UNIQUE CASCADE AND OR AS JOIN LEFT INNER GROUP BY ORDER LIMIT " +
    "BEGIN COMMIT GRANT REVOKE TO IF EXISTS RETURNING TRUE FALSE INT INTEGER BIGINT TEXT UUID " +
    "BOOLEAN TIMESTAMPTZ TIMESTAMP JSONB",
);

type Rules = {
  lineComments: readonly string[];
  blockComments: boolean;
  quotes: string;
  /** SQL escapes a quote by doubling it; the others use a backslash. */
  doubledQuoteEscape: boolean;
  isKeyword: (word: string) => boolean;
};

const RULES: Readonly<Record<Exclude<Language, "plain">, Rules>> = {
  js: {
    lineComments: ["//"],
    blockComments: true,
    quotes: "\"'`",
    doubledQuoteEscape: false,
    isKeyword: (w) => JS_KEYWORDS.has(w),
  },
  sql: {
    lineComments: ["--"],
    blockComments: true,
    quotes: "'\"",
    doubledQuoteEscape: true,
    isKeyword: (w) => SQL_KEYWORDS.has(w.toUpperCase()),
  },
  hash: {
    lineComments: ["#"],
    blockComments: false,
    quotes: "\"'",
    doubledQuoteEscape: false,
    isKeyword: () => false,
  },
};

const isWordStart = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isWord = (c: string) => isWordStart(c) || isDigit(c);

/** Index after the string that opens at `start`, or the end of the line if it never closes. */
const stringEnd = (line: string, start: number, rules: Rules): number => {
  const quote = line[start];
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === "\\" && !rules.doubledQuoteEscape) {
      i += 2;
    } else if (c === quote) {
      if (rules.doubledQuoteEscape && line[i + 1] === quote) i += 2;
      else return i + 1;
    } else {
      i++;
    }
  }
  return line.length;
};

/** Index after a number at `start`: decimal with `_` separators and a fraction, or 0x/0o/0b. */
const numberEnd = (line: string, start: number): number => {
  let i = start;
  const radix = line[i] === "0" ? (line[i + 1] ?? "").toLowerCase() : "";
  if (radix === "x" || radix === "o" || radix === "b") {
    i += 2;
    while (i < line.length && isWord(line[i] ?? "")) i++;
    return i;
  }
  while (i < line.length && (isDigit(line[i] ?? "") || line[i] === "_")) i++;
  if (line[i] === "." && isDigit(line[i + 1] ?? "")) {
    i++;
    while (i < line.length && (isDigit(line[i] ?? "") || line[i] === "_")) i++;
  }
  return i;
};

const highlight = (line: string, rules: Rules): Token[] => {
  const tokens: Token[] = [];
  let plainFrom = 0;
  const emit = (kind: TokenKind, start: number, end: number) => {
    if (start > plainFrom) tokens.push({ kind: "plain", text: line.slice(plainFrom, start) });
    tokens.push({ kind, text: line.slice(start, end) });
    plainFrom = end;
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i] ?? "";
    if (rules.lineComments.some((marker) => line.startsWith(marker, i))) {
      emit("com", i, line.length);
      break;
    }
    if (rules.blockComments && c === "/" && line[i + 1] === "*") {
      const close = line.indexOf("*/", i + 2);
      const end = close === -1 ? line.length : close + 2;
      emit("com", i, end);
      i = end;
    } else if (rules.quotes.includes(c)) {
      const end = stringEnd(line, i, rules);
      emit("str", i, end);
      i = end;
    } else if (isWordStart(c)) {
      let end = i + 1;
      while (end < line.length && isWord(line[end] ?? "")) end++;
      if (rules.isKeyword(line.slice(i, end))) emit("kw", i, end);
      i = end;
    } else if (isDigit(c)) {
      const end = numberEnd(line, i);
      // A number glued to letters (`2fa`, `1px`) is not a number token.
      if (end < line.length && isWordStart(line[end] ?? "")) {
        i = end;
      } else {
        emit("num", i, end);
        i = end;
      }
    } else {
      i++;
    }
  }
  if (plainFrom < line.length) tokens.push({ kind: "plain", text: line.slice(plainFrom) });
  return tokens;
};

/** Tokens whose texts, joined, are exactly `line`. Empty tokens are never returned. */
export const tokenize = (line: string, language: Language): Token[] => {
  if (line === "") return [];
  if (language === "plain") return [{ kind: "plain", text: line }];
  const head = line.length > MAX_HIGHLIGHT_CHARS ? line.slice(0, MAX_HIGHLIGHT_CHARS) : line;
  const tokens = highlight(head, RULES[language]);
  if (head.length < line.length) {
    const rest = line.slice(head.length);
    const last = tokens.at(-1);
    if (last?.kind === "plain")
      tokens[tokens.length - 1] = { kind: "plain", text: last.text + rest };
    else tokens.push({ kind: "plain", text: rest });
  }
  return tokens;
};
