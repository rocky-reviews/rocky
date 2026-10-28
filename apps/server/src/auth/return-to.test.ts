import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { returnUrl, safeReturnTo } from "./return-to.js";
import { OPEN_REDIRECT_VECTORS } from "./test-support.js";

/** P7-1 acceptance criterion (open redirect), unit level; auth.db.test.ts runs these end to end. */

describe("safeReturnTo", () => {
  it("refuses every open-redirect vector (//, backslashes, schemes, encodings, controls, look-alikes)", () => {
    for (const vector of OPEN_REDIRECT_VECTORS) {
      expect(safeReturnTo(vector), JSON.stringify(vector)).toBeNull();
    }
    for (const value of [undefined, null, 42, ["/inbox"], { href: "/" }]) {
      expect(safeReturnTo(value)).toBeNull();
    }
  });

  it("keeps same-origin relative paths with their query and fragment, normalised", () => {
    expect(safeReturnTo("/")).toBe("/");
    expect(safeReturnTo("/inbox")).toBe("/inbox");
    expect(safeReturnTo("/acme/api/pull/847?file=src/a.ts&q=%C3%A9#L12")).toBe(
      "/acme/api/pull/847?file=src/a.ts&q=%C3%A9#L12",
    );
    // Strict on purpose: an encoded slash is refused even in the query (falls back to /).
    expect(safeReturnTo("/pull/847?file=src%2Fa.ts")).toBeNull();
    expect(safeReturnTo("/a/./b/../c")).toBe("/a/c");
    expect(safeReturnTo("/@evil.com")).toBe("/@evil.com");
    expect(safeReturnTo("/authx")).toBe("/authx");
    expect(safeReturnTo("/inbox?next=/auth/github/login")).toBe("/inbox?next=/auth/github/login");
  });

  it("refuses a loop into the auth routes however it is spelled", () => {
    for (const loop of [
      "/auth",
      "/auth/github/login",
      "/auth?x=1",
      "/auth#x",
      "/%61uth/github/login",
      "/%61%75%74%68",
      "/AUTH/github/login",
      "/Auth/logout",
      "/a/../auth/github/callback",
    ]) {
      expect(safeReturnTo(loop), loop).toBeNull();
    }
  });

  it("property: anything accepted resolves to Rocky's own origin, on any public origin", () => {
    const origins = ["https://rocky.example.com", "http://127.0.0.1:4310"];
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 64 }),
          fc.string({ maxLength: 64 }).map((s) => `/${s}`),
          fc.webUrl(),
          fc.webPath(),
        ),
        (candidate) => {
          const safe = safeReturnTo(candidate);
          if (safe === null) return;
          expect(safe.startsWith("/")).toBe(true);
          expect(safe.startsWith("//")).toBe(false);
          for (const origin of origins) {
            expect(new URL(safe, origin).origin).toBe(origin);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe("returnUrl", () => {
  it("builds an absolute URL on the public origin and falls back to / for anything unsafe", () => {
    const publicUrl = new URL("https://rocky.example.com/");
    expect(returnUrl("/inbox?x=1", publicUrl).href).toBe("https://rocky.example.com/inbox?x=1");
    for (const vector of OPEN_REDIRECT_VECTORS) {
      expect(returnUrl(vector, publicUrl).href, JSON.stringify(vector)).toBe(
        "https://rocky.example.com/",
      );
    }
  });
});
