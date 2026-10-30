import { DENY_TTL_MS, ForgeReadError, type RepositoryRef } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import { cacheMembershipDenials } from "./repository-access.js";

/**
 * H4-1 (ADR 0033 W11): "not a collaborator" answers are remembered for at most the core's deny
 * lifetime, keyed by installation, repository and login; `true` and errors are never remembered.
 */

const T0 = Date.parse("2026-10-30T10:00:00Z");
const REF: RepositoryRef = { installationId: 81, repositoryId: 2001 };

const scripted = () => {
  const calls: { ref: RepositoryRef; login: string }[] = [];
  const answers = new Map<string, boolean | Error>();
  const key = (ref: RepositoryRef, login: string) =>
    `${ref.installationId}:${ref.repositoryId}:${login}`;
  return {
    calls,
    set: (ref: RepositoryRef, login: string, answer: boolean | Error) =>
      answers.set(key(ref, login), answer),
    inner: {
      isCollaborator: async (ref: RepositoryRef, login: string) => {
        calls.push({ ref, login });
        const answer = answers.get(key(ref, login));
        if (answer instanceof Error) throw answer;
        return answer ?? false;
      },
    },
  };
};

const setup = (options: { ttlMs?: number; maxEntries?: number } = {}) => {
  const now = { ms: T0 };
  const gh = scripted();
  const reader = cacheMembershipDenials(gh.inner, {
    clock: { now: () => new Date(now.ms) },
    ...options,
  });
  return { now, gh, reader };
};

describe("cacheMembershipDenials", () => {
  it("remembers false for the deny lifetime, then asks again", async () => {
    const { now, gh, reader } = setup();
    gh.set(REF, "bob", false);
    expect(await reader.isCollaborator(REF, "bob")).toBe(false);
    expect(await reader.isCollaborator(REF, "bob")).toBe(false);
    now.ms = T0 + DENY_TTL_MS - 1;
    expect(await reader.isCollaborator(REF, "bob")).toBe(false);
    expect(gh.calls).toHaveLength(1);
    now.ms = T0 + DENY_TTL_MS;
    gh.set(REF, "bob", true);
    expect(await reader.isCollaborator(REF, "bob")).toBe(true);
    expect(gh.calls).toHaveLength(2);
  });

  it("never remembers true: a collaborator question always reaches the forge", async () => {
    const { gh, reader } = setup();
    gh.set(REF, "alice", true);
    expect(await reader.isCollaborator(REF, "alice")).toBe(true);
    gh.set(REF, "alice", false);
    // Removed on GitHub: the next question sees it at once (the 5-minute bound is the core's).
    expect(await reader.isCollaborator(REF, "alice")).toBe(false);
    expect(gh.calls).toHaveLength(2);
  });

  it("never remembers an error, and an error does not replace a remembered false", async () => {
    const { gh, reader } = setup();
    gh.set(REF, "carol", new ForgeReadError("network"));
    await expect(reader.isCollaborator(REF, "carol")).rejects.toBeInstanceOf(ForgeReadError);
    await expect(reader.isCollaborator(REF, "carol")).rejects.toBeInstanceOf(ForgeReadError);
    expect(gh.calls).toHaveLength(2);
  });

  it("keys by installation, repository and login (case-insensitive login)", async () => {
    const { gh, reader } = setup();
    gh.set(REF, "bob", false);
    expect(await reader.isCollaborator(REF, "bob")).toBe(false);
    gh.set({ installationId: 82, repositoryId: 2001 }, "bob", true);
    gh.set({ installationId: 81, repositoryId: 2002 }, "bob", true);
    gh.set(REF, "bobby", true);
    expect(await reader.isCollaborator({ installationId: 82, repositoryId: 2001 }, "bob")).toBe(
      true,
    );
    expect(await reader.isCollaborator({ installationId: 81, repositoryId: 2002 }, "bob")).toBe(
      true,
    );
    expect(await reader.isCollaborator(REF, "bobby")).toBe(true);
    // GitHub logins are case-insensitive: one entry.
    expect(await reader.isCollaborator(REF, "BOB")).toBe(false);
    expect(gh.calls.map((c) => c.login)).toEqual(["bob", "bob", "bob", "bobby"]);
  });

  it("passes malformed input through uncached (the adapter refuses it)", async () => {
    const { gh, reader } = setup();
    const bad: [RepositoryRef, string][] = [
      [REF, "-bob"],
      [REF, "a".repeat(40)],
      [REF, "bob/../x"],
      [{ installationId: 0, repositoryId: 2001 }, "bob"],
      [{ installationId: 81, repositoryId: 1.5 }, "bob"],
      [REF, 7 as unknown as string],
    ];
    for (const [ref, login] of bad) {
      expect(await reader.isCollaborator(ref, login)).toBe(false);
      expect(await reader.isCollaborator(ref, login)).toBe(false);
    }
    expect(gh.calls).toHaveLength(bad.length * 2);
  });

  it("a clock that moves backwards does not keep an entry alive", async () => {
    const { now, gh, reader } = setup();
    gh.set(REF, "bob", false);
    expect(await reader.isCollaborator(REF, "bob")).toBe(false);
    now.ms = T0 - 1;
    gh.set(REF, "bob", true);
    expect(await reader.isCollaborator(REF, "bob")).toBe(true);
    expect(gh.calls).toHaveLength(2);
  });

  it("holds at most maxEntries, least recently used first", async () => {
    const { gh, reader } = setup({ maxEntries: 2 });
    const ref = (id: number): RepositoryRef => ({ installationId: 81, repositoryId: id });
    for (const id of [1, 2]) gh.set(ref(id), "bob", false);
    await reader.isCollaborator(ref(1), "bob");
    await reader.isCollaborator(ref(2), "bob");
    await reader.isCollaborator(ref(1), "bob"); // a hit: 1 is now the most recent
    gh.set(ref(3), "bob", false);
    await reader.isCollaborator(ref(3), "bob"); // evicts 2
    await reader.isCollaborator(ref(1), "bob"); // still cached
    await reader.isCollaborator(ref(2), "bob"); // asked again
    expect(gh.calls.map((c) => c.ref.repositoryId)).toEqual([1, 2, 3, 2]);
  });

  it("refuses a lifetime above the core's deny lifetime, or an unbounded cache", () => {
    const inner = { isCollaborator: async () => false };
    expect(() => cacheMembershipDenials(inner, { ttlMs: DENY_TTL_MS + 1 })).toThrow(RangeError);
    expect(() => cacheMembershipDenials(inner, { ttlMs: 0 })).toThrow(RangeError);
    expect(() => cacheMembershipDenials(inner, { maxEntries: 0 })).toThrow(RangeError);
    expect(() => cacheMembershipDenials(inner, { ttlMs: DENY_TTL_MS })).not.toThrow();
  });
});
