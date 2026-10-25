import { REDACTED, isErrorCodeIdentifier, isSensitiveKey, normaliseKey } from "./redact-paths.js";

/** Strings longer than this are not scanned at all; nothing that belongs in a log is this big. */
export const MAX_SCAN_LENGTH = 1_048_576;
/** Longest string value emitted; the rest is cut off (a pasted diff cannot be logged whole). */
export const MAX_STRING_LENGTH = 8192;
/** Nesting limit for the deep scrub. */
export const MAX_DEPTH = 8;
/** Total object entries and array items visited per log call. */
export const MAX_NODES = 1000;

/**
 * Value-level patterns for secrets that could appear inside free text (messages, error
 * messages, stack traces, URLs). Every quantifier is bounded and every pattern is a single
 * run of one character class between literal anchors, so matching is linear: no nested or
 * overlapping quantifiers that could backtrack catastrophically. Specific kinds come before
 * generic ones (`sk-ant-` before `sk-`).
 */
const PATTERNS: readonly { readonly kind: string; readonly regex: RegExp }[] = [
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
  { kind: "bearer", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,4096}/g },
  { kind: "basic_auth", regex: /\bBasic\s+[A-Za-z0-9+/]{8,4096}={0,2}/g },
  {
    kind: "email",
    regex: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}/g,
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
  for (const { kind, regex } of PATTERNS) out = out.replace(regex, `[redacted:${kind}]`);
  return out;
};

const truncate = (text: string): string =>
  text.length <= MAX_STRING_LENGTH
    ? text
    : `${text.slice(0, MAX_STRING_LENGTH)}…[truncated ${text.length - MAX_STRING_LENGTH} chars]`;

/** Scrub, then cut: the kept prefix is clean and the dropped tail is never emitted. */
export const scrubString = (text: string): string => truncate(scrubSecrets(text));

interface Walk {
  nodes: number;
  readonly seen: WeakSet<object>;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const walkEntry = (key: string, value: unknown, depth: number, state: Walk): unknown => {
  if (isSensitiveKey(key)) {
    return normaliseKey(key) === "code" && isErrorCodeIdentifier(value) ? value : REDACTED;
  }
  return walk(value, depth + 1, state);
};

const walkError = (error: Error, depth: number, state: Walk): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    type: error.constructor.name,
    message: scrubString(error.message),
  };
  if (typeof error.stack === "string") out["stack"] = scrubString(error.stack);
  // Own enumerable properties such as `code`, `statusCode` or a wrapped `response`.
  for (const [key, value] of Object.entries(error)) {
    if (++state.nodes > MAX_NODES) break;
    out[key] = walkEntry(key, value, depth, state);
  }
  if (error.cause !== undefined) out["cause"] = walk(error.cause, depth + 1, state);
  return out;
};

const walk = (value: unknown, depth: number, state: Walk): unknown => {
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object" || value === null) return value;
  if (state.seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (value instanceof Error) {
    state.seen.add(value);
    return walkError(value, depth, state);
  }
  // Class instances (requests, dates, buffers) are left to pino's serializers and toJSON.
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  state.seen.add(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (++state.nodes > MAX_NODES) {
        out.push("[truncated]");
        break;
      }
      out.push(walk(item, depth + 1, state));
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (++state.nodes > MAX_NODES) {
      out["…"] = "[truncated]";
      break;
    }
    out[key] = walkEntry(key, item, depth, state);
  }
  return out;
};

/**
 * Deep copy of a log payload with sensitive keys redacted at any depth, secrets scrubbed from
 * every string, Error instances serialised, and depth/size/cycle limits applied. Primitives and
 * non-plain objects are returned as they are.
 */
export const scrubValue = (value: unknown): unknown =>
  walk(value, 0, { nodes: 0, seen: new WeakSet() });
