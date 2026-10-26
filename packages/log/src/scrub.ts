import { REDACTED, isErrorCodeIdentifier, isSensitiveKey, normaliseKey } from "./redact-paths.js";

/** `scrubSecrets` refuses to scan anything longer than this; nothing in a log is this big. */
export const MAX_SCAN_LENGTH = 1_048_576;
/** Longest string value emitted; the rest is cut off (a pasted diff cannot be logged whole). */
export const MAX_STRING_LENGTH = 8192;
/**
 * Extra characters scanned beyond `MAX_STRING_LENGTH` before cutting, so a secret straddling the
 * cut is still recognised. Covers every pattern below except a JWT with 4 KiB segments.
 */
export const SCAN_MARGIN = 4096;
/** Nesting limit for the deep scrub. */
export const MAX_DEPTH = 8;
/** Object entries and array items visited per log call. */
export const MAX_NODES = 1000;
/** String characters scanned per log call; further strings are replaced by a marker. */
export const MAX_CHARS_PER_CALL = 65_536;

interface Pattern {
  readonly kind: string;
  readonly regex: RegExp;
  readonly replacement?: string;
}

/**
 * Value-level patterns for secrets that could appear inside free text (messages, error
 * messages, stack traces, URLs). Every quantifier is bounded and every pattern is a run of one
 * character class between literal anchors, so matching is linear: no nested or overlapping
 * quantifiers that could backtrack catastrophically. Order matters: URL userinfo first (it may
 * contain any of the others), specific kinds before generic ones (`sk-ant-` before `sk-`).
 */
const PATTERNS: readonly Pattern[] = [
  {
    kind: "userinfo",
    regex: /\b([a-z][a-z0-9+.-]{1,20}):\/\/[^\s/@]{1,256}@/gi,
    replacement: "$1://[redacted:userinfo]@",
  },
  { kind: "github_token", regex: /\bgh[opsur]_[A-Za-z0-9]{20,255}/g },
  { kind: "github_token", regex: /\bgithub_pat_[A-Za-z0-9_]{20,255}/g },
  { kind: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,255}/g },
  { kind: "api_key", regex: /\bsk-[A-Za-z0-9_-]{16,255}/g },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g,
  },
  {
    kind: "aws_secret_key",
    regex: /\baws[_ -]?secret[_ -]?(?:access[_ -]?)?key\b[\s:="']{0,8}[A-Za-z0-9/+]{40}/gi,
  },
  { kind: "aws_access_key", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { kind: "bearer", regex: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,4096}/gi },
  // GitHub's `Authorization: token <x>` scheme, and the classic 40-hex token after `token`.
  { kind: "token", regex: /\bauthorization\b\s*[:=]\s*["']?token\s+[A-Za-z0-9._~+/=-]{16,4096}/gi },
  { kind: "token", regex: /\btoken\s+[0-9a-f]{40}\b/gi },
  { kind: "basic_auth", regex: /\bBasic\s+[A-Za-z0-9+/]{8,4096}={0,2}/g },
  {
    kind: "email",
    // The TLD must be alphabetic so package specifiers (`pino@10.4.0`) are left alone.
    regex: /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,63}\b/g,
  },
];

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;

/** Removes PEM private-key blocks; a block with no END marker is removed to the end of the text. */
const scrubPem = (text: string): string => {
  if (!text.includes("-----BEGIN")) return text;
  let out = "";
  let cursor = 0;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(text); begin !== null; begin = PEM_BEGIN.exec(text)) {
    out += text.slice(cursor, begin.index) + "[redacted:private_key]";
    PEM_END.lastIndex = begin.index + begin[0].length;
    const end = PEM_END.exec(text);
    if (end === null) return out;
    cursor = end.index + end[0].length;
    PEM_BEGIN.lastIndex = cursor;
  }
  return out + text.slice(cursor);
};

/** Replaces anything that looks like a credential or an email address in free text. */
export const scrubSecrets = (text: string): string => {
  if (text.length > MAX_SCAN_LENGTH) return `[truncated: ${text.length} chars not scanned]`;
  let out = scrubPem(text);
  for (const { kind, regex, replacement } of PATTERNS) {
    out = out.replace(regex, replacement ?? `[redacted:${kind}]`);
  }
  return out;
};

/** Per-log-call accounting shared by every string and object the call touches. */
export interface ScrubBudget {
  nodes: number;
  chars: number;
  readonly seen: WeakSet<object>;
}

export const newScrubBudget = (): ScrubBudget => ({ nodes: 0, chars: 0, seen: new WeakSet() });

/**
 * Bounded scrub of one string: take at most `MAX_STRING_LENGTH + SCAN_MARGIN` characters, scrub
 * that window, then cut to `MAX_STRING_LENGTH`. The kept prefix is clean, the dropped tail is
 * never emitted, and the work per string is constant whatever its size. With a budget, strings
 * past the per-call character limit are replaced by a marker without being scanned.
 */
export const scrubString = (text: string, budget?: ScrubBudget): string => {
  if (budget !== undefined) {
    if (budget.chars >= MAX_CHARS_PER_CALL) {
      return `[truncated ${text.length} chars: log call budget exhausted]`;
    }
    budget.chars += Math.min(text.length, MAX_STRING_LENGTH + SCAN_MARGIN);
  }
  if (text.length <= MAX_STRING_LENGTH) return scrubSecrets(text);
  const scrubbed = scrubSecrets(text.slice(0, MAX_STRING_LENGTH + SCAN_MARGIN));
  return `${scrubbed.slice(0, MAX_STRING_LENGTH)}…[truncated ${text.length - MAX_STRING_LENGTH} chars]`;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const typeName = (value: object): string => {
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name !== "" ? name : "Object";
};

const walkEntry = (
  key: string,
  value: unknown,
  depth: number,
  budget: ScrubBudget,
  ofError: boolean,
): unknown => {
  if (isSensitiveKey(key)) {
    const keepCode = ofError && normaliseKey(key) === "code" && isErrorCodeIdentifier(value);
    return keepCode ? value : REDACTED;
  }
  return walk(value, depth + 1, budget);
};

const walkObject = (
  entries: Iterable<[string, unknown]>,
  depth: number,
  budget: ScrubBudget,
  ofError = false,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (++budget.nodes > MAX_NODES) {
      out["…"] = "[truncated]";
      break;
    }
    out[key] = walkEntry(key, item, depth, budget, ofError);
  }
  return out;
};

const walkArray = (items: Iterable<unknown>, depth: number, budget: ScrubBudget): unknown[] => {
  const out: unknown[] = [];
  for (const item of items) {
    if (++budget.nodes > MAX_NODES) {
      out.push("[truncated]");
      break;
    }
    out.push(walk(item, depth + 1, budget));
  }
  return out;
};

const walkError = (error: Error, depth: number, budget: ScrubBudget): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    type: typeName(error),
    message: scrubString(error.message, budget),
  };
  if (typeof error.stack === "string") out["stack"] = scrubString(error.stack, budget);
  // Own enumerable properties such as `code`, `statusCode`, `config` or `response`.
  Object.assign(out, walkObject(Object.entries(error), depth, budget, true));
  if (error.cause !== undefined) out["cause"] = walk(error.cause, depth + 1, budget);
  return out;
};

/** `protocol//host/path`: no userinfo, no query, no fragment; the path is scrubbed like text. */
const sanitiseUrl = (url: URL, budget: ScrubBudget): string =>
  `${url.protocol}//${url.host}${scrubString(url.pathname, budget)}`;

/**
 * Class instances are never passed through (their getters and `toJSON` would run inside pino,
 * and their fields would escape redaction): known shapes are converted to plain data and
 * walked, everything else becomes an opaque `[object Name]`.
 */
const walkInstance = (value: object, depth: number, budget: ScrubBudget): unknown => {
  if (value instanceof URL) return sanitiseUrl(value, budget);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
    return `[object ${typeName(value)}]`;
  if (value instanceof Map) {
    return walkObject(
      [...value].map(([k, v]): [string, unknown] => [String(k), v]),
      depth,
      budget,
    );
  }
  if (value instanceof Set) return walkArray(value, depth, budget);
  if (typeof Headers !== "undefined" && value instanceof Headers) {
    return walkObject(value.entries(), depth, budget);
  }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    try {
      return walk((toJSON as () => unknown).call(value), depth + 1, budget);
    } catch {
      return `[object ${typeName(value)}]`;
    }
  }
  return `[object ${typeName(value)}]`;
};

const walk = (value: unknown, depth: number, budget: ScrubBudget): unknown => {
  if (typeof value === "string") return scrubString(value, budget);
  if (typeof value !== "object" || value === null) return value;
  if (budget.seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  budget.seen.add(value);
  if (value instanceof Error) return walkError(value, depth, budget);
  if (Array.isArray(value)) return walkArray(value, depth, budget);
  if (isPlainObject(value)) return walkObject(Object.entries(value), depth, budget);
  return walkInstance(value, depth, budget);
};

/**
 * Deep copy of a log payload with sensitive keys redacted at any depth, secrets scrubbed from
 * every string, Error instances serialised, class instances normalised, and depth/size/cycle
 * limits applied against one budget per log call. Primitives are returned as they are.
 */
export const scrubValue = (value: unknown, budget: ScrubBudget = newScrubBudget()): unknown =>
  walk(value, 0, budget);
