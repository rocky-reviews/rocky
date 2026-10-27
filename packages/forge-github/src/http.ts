/**
 * Small HTTP helpers shared by the GitHub calls (manifest conversion, app API). Responses are
 * read with a byte cap so a hostile or broken endpoint cannot make the process buffer without
 * bound; errors are reduced to fixed reasons by the callers.
 */

/** The body, or `undefined` when it is (or announces to be) larger than `limit` bytes. */
export const readCapped = async (
  response: Response,
  limit: number,
): Promise<Buffer | undefined> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) return undefined;
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

/** A fetch aborted by its timeout signal (or any abort). */
export const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
