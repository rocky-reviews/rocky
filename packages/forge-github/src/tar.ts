import { ForgeReadError, type ArchiveFile } from "@rocky-reviews/core";

/**
 * A streaming reader for the tar archives GitHub serves (`git archive` output: ustar, a global
 * pax header holding the commit id, pax `path` records for long names), P9-1. The archive is
 * untrusted input and is never written to disk:
 *
 * - only regular files are yielded; directories, symlinks, hard links, devices and anything
 *   unknown are skipped, so no link can point a later read elsewhere;
 * - the top-level directory GitHub puts everything under is dropped, and a path left empty,
 *   absolute, with `.`/`..` segments, control characters or invalid UTF-8 is skipped;
 * - every header checksum is verified, pax records are bounded, and the total of bytes read and
 *   the number of entries are capped: past either the archive is refused (`invalid_response`);
 * - a file over `maxFileBytes` is skipped over without being buffered (yielded with `bytes: null`
 *   when wanted, so the caller can count it).
 */

const BLOCK = 512;
const MAX_PAX_BYTES = 64 * 1024;

export interface TarLimits {
  readonly maxFileBytes: number;
  readonly wanted: (path: string) => boolean;
  /** Most bytes of archive (decompressed) read before the archive is refused. */
  readonly maxTotalBytes: number;
  /** Most entries (of any type) before the archive is refused. */
  readonly maxEntries: number;
}

const broken = (): ForgeReadError => new ForgeReadError("invalid_response");

/** Pulls exact byte counts out of a stream of chunks, never holding more than one request. */
class ByteSource {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private done = false;
  total = 0;

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly cap: number,
  ) {
    this.reader = stream.getReader();
  }

  private async fill(n: number): Promise<void> {
    while (this.buffered < n && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
        break;
      }
      this.total += value.byteLength;
      if (this.total > this.cap) throw broken();
      this.chunks.push(value);
      this.buffered += value.byteLength;
    }
  }

  /** Exactly `n` bytes, or `null` at a clean end of stream; a short read is a broken archive. */
  async read(n: number): Promise<Uint8Array | null> {
    await this.fill(n);
    if (this.buffered === 0 && this.done) return null;
    if (this.buffered < n) throw broken();
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0] as Uint8Array;
      const take = Math.min(head.byteLength, n - offset);
      out.set(head.subarray(0, take), offset);
      offset += take;
      if (take === head.byteLength) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.buffered -= n;
    return out;
  }

  /** Discards `n` bytes without keeping them. */
  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) {
      await this.fill(Math.min(left, 1024 * 1024));
      if (this.buffered === 0) throw broken();
      const head = this.chunks[0] as Uint8Array;
      const take = Math.min(head.byteLength, left);
      if (take === head.byteLength) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      this.buffered -= take;
      left -= take;
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

const field = (header: Uint8Array, offset: number, length: number): Uint8Array => {
  const slice = header.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return nul === -1 ? slice : slice.subarray(0, nul);
};

const text = (bytes: Uint8Array): string | undefined => {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
};

/** An octal number field, or GNU base-256 for large sizes. */
const number = (header: Uint8Array, offset: number, length: number): number => {
  const first = header[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + (header[offset + i] ?? 0);
    if (!Number.isSafeInteger(value)) throw broken();
    return value;
  }
  const raw = new TextDecoder("latin1").decode(field(header, offset, length)).trim();
  if (raw === "") return 0;
  if (!/^[0-7]{1,22}$/.test(raw)) throw broken();
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) throw broken();
  return value;
};

const checksumOk = (header: Uint8Array): boolean => {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum === number(header, 148, 8);
};

/** `len key=value\n` records; only `path` and `size` are kept. */
const paxRecords = (data: Uint8Array): { path?: string; size?: number } => {
  const out: { path?: string; size?: number } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw broken();
    const lengthText = new TextDecoder("latin1").decode(data.subarray(offset, space));
    if (!/^[1-9][0-9]{0,6}$/.test(lengthText)) throw broken();
    const length = Number(lengthText);
    const end = offset + length;
    if (end > data.length || data[end - 1] !== 0x0a) throw broken();
    const record = text(data.subarray(space + 1, end - 1));
    if (record === undefined) throw broken();
    const eq = record.indexOf("=");
    if (eq === -1) throw broken();
    const key = record.slice(0, eq);
    const value = record.slice(eq + 1);
    if (key === "path") out.path = value;
    if (key === "size") {
      if (!/^[0-9]{1,15}$/.test(value)) throw broken();
      out.size = Number(value);
    }
    offset = end;
  }
  return out;
};

/** The path below GitHub's top-level directory, or undefined when it is not a usable one. */
const relative = (full: string): string | undefined => {
  const slash = full.indexOf("/");
  if (slash === -1) return undefined;
  const rest = full.slice(slash + 1);
  if (rest === "" || rest.startsWith("/")) return undefined;
  for (let i = 0; i < rest.length; i++) {
    const code = rest.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  if (rest.split("/").some((s) => s === "" || s === "." || s === "..")) return undefined;
  return rest;
};

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

export async function* readTar(
  stream: ReadableStream<Uint8Array>,
  limits: TarLimits,
): AsyncIterable<ArchiveFile> {
  const source = new ByteSource(stream, limits.maxTotalBytes);
  let entries = 0;
  let pax: { path?: string; size?: number } = {};
  let longName: string | undefined;
  try {
    for (;;) {
      const header = await source.read(BLOCK);
      if (header === null) return;
      if (header.every((b) => b === 0)) return;
      if (!checksumOk(header)) throw broken();
      if (++entries > limits.maxEntries) throw broken();
      const type = String.fromCharCode(header[156] ?? 0);
      const size = number(header, 124, 12);
      const body = size + padding(size);

      if (type === "x" || type === "g" || type === "L") {
        if (size > MAX_PAX_BYTES) throw broken();
        const data = (await source.read(body)) ?? new Uint8Array();
        if (type === "x") pax = paxRecords(data.subarray(0, size));
        if (type === "L") longName = text(field(data, 0, size)) ?? "";
        continue;
      }

      const ustar = new TextDecoder("latin1").decode(header.subarray(257, 262)) === "ustar";
      const name = text(field(header, 0, 100));
      const prefix = ustar ? text(field(header, 345, 155)) : "";
      const full =
        pax.path ??
        longName ??
        (name === undefined || prefix === undefined
          ? undefined
          : prefix === ""
            ? name
            : `${prefix}/${name}`);
      const fileSize = pax.size ?? size;
      const dataBlocks = pax.size === undefined ? body : fileSize + padding(fileSize);
      pax = {};
      longName = undefined;

      const regular = type === "0" || type === "\0" || type === "7";
      const path = regular && full !== undefined ? relative(full) : undefined;
      if (path === undefined || !limits.wanted(path)) {
        await source.skip(dataBlocks);
        continue;
      }
      if (fileSize > limits.maxFileBytes) {
        await source.skip(dataBlocks);
        yield { path, size: fileSize, bytes: null };
        continue;
      }
      const data = (await source.read(dataBlocks)) ?? new Uint8Array();
      yield { path, size: fileSize, bytes: data.slice(0, fileSize) };
    }
  } finally {
    await source.cancel();
  }
}
