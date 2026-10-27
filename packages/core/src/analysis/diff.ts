/**
 * Unified diff reader (P4-3, ADR 0014 §2). The revision's diff is where the known facts come
 * from: paths, statuses, line counts and hunk ranges (ADR 0004 §3). It is untrusted PR content,
 * so the reader is strict and total: it never throws, it never guesses a path, and a hunk is read
 * by its header's line counts, so content inside a hunk can never pass for a header. Anything it
 * does not understand fails the whole diff (fail closed) rather than dropping a file from review.
 */
import { limits, RepositoryPath, type FileStatus, type Hunk } from "@rocky-reviews/schema";

/** Patch lines sent to a model for one file; a longer file is `tooLarge` (P4-6 splits). */
export const MAX_FILE_PATCH_LINES = 5_000;
/** Patch bytes (UTF-16 units, a cheap bound) sent to a model for one file. */
export const MAX_FILE_PATCH_CHARS = 200_000;

export interface DiffFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: FileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly Hunk[];
  readonly binary: boolean;
  /** Over `MAX_FILE_PATCH_LINES` or `MAX_FILE_PATCH_CHARS`: never sent to a model. */
  readonly tooLarge: boolean;
  /** The file's section of the diff, verbatim. Untrusted content: never logged. */
  readonly patch: string;
  /** The whole new-side file, when the diff holds all of it (an added text file). */
  readonly newFileLines?: readonly string[];
}

/** Fixed codes: safe to store as `analyses.error_code` and to log. */
export type DiffFailure =
  "diff_unparseable" | "diff_unsupported_path" | "diff_too_large" | "too_many_files";

export type DiffParse =
  | { readonly ok: true; readonly files: readonly DiffFile[] }
  | { readonly ok: false; readonly code: DiffFailure };

class DiffError extends Error {
  constructor(readonly code: DiffFailure) {
    super(code);
  }
}

const fail = (code: DiffFailure): never => {
  throw new DiffError(code);
};

const ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** Git's C-style quoting (`"a/caf\303\251"`): escapes and octal bytes, then UTF-8. */
const unquote = (quoted: string): string => {
  const bytes: number[] = [];
  for (let i = 1; i < quoted.length - 1; i++) {
    const char = quoted[i] ?? "";
    if (char !== "\\") {
      for (const byte of encoder.encode(char)) bytes.push(byte);
      continue;
    }
    const next = quoted[i + 1] ?? "";
    const octal = /^[0-3][0-7]{2}/.exec(quoted.slice(i + 1, i + 4));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else if (next in ESCAPES) {
      bytes.push(ESCAPES[next] ?? 0);
      i += 1;
    } else {
      fail("diff_unsupported_path");
    }
  }
  try {
    return utf8.decode(new Uint8Array(bytes));
  } catch {
    return fail("diff_unsupported_path");
  }
};

/** `a/x`, `"a/x"` (quoted) or `/dev/null` (undefined); one trailing tab is git's, not the path's. */
const sidePath = (raw: string, prefix: "a/" | "b/"): string | undefined => {
  const value = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (value === "/dev/null") return undefined;
  const path =
    value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? unquote(value) : value;
  if (!path.startsWith(prefix)) return fail("diff_unparseable");
  return path.slice(prefix.length);
};

const QUOTED_PAIR = /^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/;

/** Both paths from `diff --git a/X b/Y`, when they can be told apart without guessing. */
const headerPaths = (rest: string): { old: string; new: string } | undefined => {
  const quoted = QUOTED_PAIR.exec(rest);
  if (quoted !== null) {
    const old = sidePath(quoted[1] ?? "", "a/");
    const next = sidePath(quoted[2] ?? "", "b/");
    return old === undefined || next === undefined ? undefined : { old, new: next };
  }
  // Unquoted: one space splits unambiguously; otherwise only the symmetric form `a/P b/P` does.
  const parts = rest.split(" ");
  if (parts.length === 2) {
    const [left = "", right = ""] = parts;
    return left.startsWith("a/") && right.startsWith("b/")
      ? { old: left.slice(2), new: right.slice(2) }
      : undefined;
  }
  if (rest.length % 2 === 0) return undefined;
  const half = (rest.length - 1) / 2;
  const left = rest.slice(0, half);
  const right = rest.slice(half + 1);
  if (rest[half] !== " " || !left.startsWith("a/") || !right.startsWith("b/")) return undefined;
  if (left.slice(2) !== right.slice(2)) return undefined;
  return { old: left.slice(2), new: right.slice(2) };
};

const HUNK_HEADER = /^@@ -(\d{1,9})(?:,(\d{1,9}))? \+(\d{1,9})(?:,(\d{1,9}))? @@/;

/** Header lines git writes between `diff --git` and the first hunk. Anything else fails. */
const HEADER_LINE =
  /^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?|(?:old|new|deleted file|new file) mode [0-7]{6}|(?:dis)?similarity index \d{1,3}%)$/;

/**
 * `rename from|to <path>` and `copy from|to <path>`. Git C-quotes the path (`quote_c_style`) when
 * it needs to, and writes it without an `a/` or `b/` prefix.
 */
const MOVE = /^(rename|copy) (from|to) (.+)$/;

const movePath = (raw: string): string =>
  raw.startsWith('"')
    ? raw.length >= 2 && raw.endsWith('"')
      ? unquote(raw)
      : fail("diff_unsupported_path")
    : raw;

const checkPath = (path: string): string => {
  if (!RepositoryPath.safeParse(path).success) fail("diff_unsupported_path");
  return path;
};

interface Draft {
  oldPath: string | undefined;
  newPath: string | undefined;
  headerOld: string | undefined;
  headerNew: string | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  copyFrom: string | undefined;
  copyTo: string | undefined;
  /** A `---` / `+++` line was read (its path may be /dev/null, i.e. undefined). */
  sawMinus: boolean;
  sawPlus: boolean;
  created: boolean;
  deleted: boolean;
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  added: string[];
  start: number;
}

/** Every source that names one side must name the same path (review round 1, Fix D). */
const oneSide = (...candidates: (string | undefined)[]): string | undefined => {
  const named = candidates.filter((c): c is string => c !== undefined);
  if (named.some((c) => c !== named[0])) fail("diff_unparseable");
  return named[0];
};

const finish = (draft: Draft, lines: readonly string[], end: number): DiffFile => {
  if (draft.sawMinus !== draft.sawPlus) fail("diff_unparseable");
  const renamed = draft.renameFrom !== undefined || draft.renameTo !== undefined;
  const copied = draft.copyFrom !== undefined || draft.copyTo !== undefined;
  if ([draft.created, draft.deleted, renamed, copied].filter(Boolean).length > 1) {
    fail("diff_unparseable");
  }
  // A new file has no base side and a deleted one no head side.
  if (draft.created && draft.oldPath !== undefined) fail("diff_unparseable");
  if (draft.deleted && draft.newPath !== undefined) fail("diff_unparseable");
  const oldSide = oneSide(draft.headerOld, draft.renameFrom, draft.copyFrom, draft.oldPath);
  const newSide = oneSide(draft.headerNew, draft.renameTo, draft.copyTo, draft.newPath);
  // A copy creates its target; the source is unchanged, so the diff is a new file's.
  const status: FileStatus =
    draft.created || copied
      ? "added"
      : draft.deleted
        ? "removed"
        : renamed
          ? "renamed"
          : "modified";
  const newPath = status === "removed" ? oldSide : newSide;
  const oldPath = oldSide;
  if (newPath === undefined) return fail("diff_unparseable");
  const path = checkPath(newPath);
  const previousPath =
    status === "renamed" && oldPath !== undefined && oldPath !== path
      ? checkPath(oldPath)
      : undefined;
  if (draft.hunks.length > limits.MAX_HUNKS_PER_FILE) fail("diff_too_large");
  const patchLines = lines.slice(draft.start, end);
  const patch = patchLines.join("\n");
  const single = draft.hunks[0];
  const whole =
    status === "added" &&
    !draft.binary &&
    draft.hunks.length === 1 &&
    single !== undefined &&
    single.oldLines === 0 &&
    single.newStart === 1;
  return {
    path,
    ...(previousPath === undefined ? {} : { previousPath }),
    status,
    additions: draft.additions,
    deletions: draft.deletions,
    hunks: draft.hunks,
    binary: draft.binary,
    tooLarge: patchLines.length > MAX_FILE_PATCH_LINES || patch.length > MAX_FILE_PATCH_CHARS,
    patch,
    ...(whole ? { newFileLines: draft.added } : {}),
  };
};

const count = (raw: string | undefined): number => {
  const value = raw === undefined ? 1 : Number.parseInt(raw, 10);
  if (value > limits.MAX_LINE_NUMBER) fail("diff_unparseable");
  return value;
};

/** Reads one hunk starting at `index` (its header); returns the index after it. */
const readHunk = (lines: readonly string[], index: number, draft: Draft): number => {
  const match = HUNK_HEADER.exec(lines[index] ?? "");
  if (match === null) return fail("diff_unparseable");
  const hunk: Hunk = {
    oldStart: count(match[1]),
    oldLines: count(match[2]),
    newStart: count(match[3]),
    newLines: count(match[4]),
  };
  if ((hunk.newLines > 0 && hunk.newStart < 1) || (hunk.oldLines > 0 && hunk.oldStart < 1)) {
    fail("diff_unparseable");
  }
  const previous = draft.hunks.at(-1);
  if (previous !== undefined) {
    const firstFree =
      previous.newLines === 0 ? previous.newStart + 1 : previous.newStart + previous.newLines;
    if (hunk.newStart < firstFree) fail("diff_unparseable");
  }
  let oldLeft = hunk.oldLines;
  let newLeft = hunk.newLines;
  let i = index + 1;
  while (oldLeft > 0 || newLeft > 0) {
    const line = lines[i];
    if (line === undefined) return fail("diff_unparseable");
    const kind = line === "" ? " " : line[0];
    if (kind === " ") {
      oldLeft--;
      newLeft--;
      draft.added.push(line.slice(1));
    } else if (kind === "+") {
      newLeft--;
      draft.additions++;
      draft.added.push(line.slice(1));
    } else if (kind === "-") {
      oldLeft--;
      draft.deletions++;
    } else if (kind !== "\\") {
      return fail("diff_unparseable");
    }
    if (oldLeft < 0 || newLeft < 0) return fail("diff_unparseable");
    i++;
  }
  if (lines[i]?.startsWith("\\") === true) i++;
  draft.hunks.push(hunk);
  return i;
};

const newDraft = (start: number, header: string): Draft => {
  const paths = headerPaths(header);
  return {
    oldPath: undefined,
    newPath: undefined,
    headerOld: paths?.old,
    headerNew: paths?.new,
    renameFrom: undefined,
    renameTo: undefined,
    copyFrom: undefined,
    copyTo: undefined,
    sawMinus: false,
    sawPlus: false,
    created: false,
    deleted: false,
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    added: [],
    start,
  };
};

const parse = (text: string): DiffFile[] => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: DiffFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i] ?? "";
    if (!header.startsWith("diff --git ")) fail("diff_unparseable");
    if (files.length >= limits.MAX_FILES) fail("too_many_files");
    const draft = newDraft(i, header.slice("diff --git ".length));
    i++;
    // Extended header lines, up to the first hunk or the next file.
    while (
      i < lines.length &&
      !(lines[i] ?? "").startsWith("diff --git ") &&
      !(lines[i] ?? "").startsWith("@@")
    ) {
      const line = lines[i] ?? "";
      if (line.startsWith("new file mode ")) draft.created = true;
      else if (line.startsWith("deleted file mode ")) draft.deleted = true;
      else if (MOVE.test(line)) {
        const [, kind, side, raw] = MOVE.exec(line) ?? [];
        const path = movePath(raw ?? "");
        const target = side === "to";
        if (kind === "rename" && target) draft.renameTo = path;
        else if (kind === "rename") draft.renameFrom = path;
        else if (target) draft.copyTo = path;
        else draft.copyFrom = path;
      } else if (line.startsWith("--- ")) {
        if (draft.sawMinus) fail("diff_unparseable");
        draft.oldPath = sidePath(line.slice(4), "a/");
        draft.sawMinus = true;
      } else if (line.startsWith("+++ ")) {
        if (!draft.sawMinus || draft.sawPlus) fail("diff_unparseable");
        draft.newPath = sidePath(line.slice(4), "b/");
        draft.sawPlus = true;
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        draft.binary = true;
        // A binary patch's payload runs to the next file.
        while (i + 1 < lines.length && !(lines[i + 1] ?? "").startsWith("diff --git ")) i++;
      } else if (!HEADER_LINE.test(line)) {
        fail("diff_unparseable");
      }
      i++;
    }
    while (i < lines.length && (lines[i] ?? "").startsWith("@@")) i = readHunk(lines, i, draft);
    if (i < lines.length && !(lines[i] ?? "").startsWith("diff --git ")) fail("diff_unparseable");
    files.push(finish(draft, lines, i));
  }
  const seen = new Set<string>();
  for (const file of files) {
    const key = file.path.normalize("NFC");
    if (seen.has(key)) fail("diff_unparseable");
    seen.add(key);
  }
  return files;
};

/** Never throws: a hostile diff is a failure code, not an exception. */
export const parseUnifiedDiff = (text: string): DiffParse => {
  try {
    return { ok: true, files: parse(text) };
  } catch (error) {
    if (error instanceof DiffError) return { ok: false, code: error.code };
    // A stack overflow or similar on hostile input: still a refusal, never a crash.
    return { ok: false, code: "diff_unparseable" };
  }
};
