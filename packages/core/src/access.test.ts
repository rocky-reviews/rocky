import { describe, expect, it } from "vitest";
import {
  ACCESS_DENY_REASONS,
  ACCESS_MAX_TTL_MS,
  createRepositoryAccessCheck,
  DENY_TTL_MS,
  TRANSIENT_DENY_TTL_MS,
  type AccessDecisionEvent,
  type AccessDenyReason,
  type RepositoryAccessAnswer,
  type RepositoryAccessRequest,
  type RepositoryAccessSource,
} from "./access.js";
import { ForgeReadError } from "./forge.js";
import type { OrgId } from "./ports.js";

/** P3-6 (ADR 0011): the access check's cache and fail-closed policy, with an injected clock. */

const ORG_A = "0b6f1c1e-1111-4a5b-8c9d-000000000001" as OrgId;
const ORG_B = "0b6f1c1e-2222-4a5b-8c9d-000000000002" as OrgId;
const ALICE = "5d1e9f00-aaaa-4bcd-9e00-000000000001";
const BOB = "5d1e9f00-bbbb-4bcd-9e00-000000000002";
const REPO = 77;
const T0 = Date.parse("2026-10-27T10:00:00Z");

const clock = (start = T0) => {
  let now = start;
  return {
    now: () => new Date(now),
    set: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const req = (
  orgId: OrgId = ORG_A,
  memberId = ALICE,
  repositoryId = REPO,
): RepositoryAccessRequest => ({ orgId, memberId, repositoryId });

/** A source whose answer per key a test sets; counts calls. */
const scripted = () => {
  const answers = new Map<
    string,
    RepositoryAccessAnswer | (() => Promise<RepositoryAccessAnswer>)
  >();
  const calls: RepositoryAccessRequest[] = [];
  const source: RepositoryAccessSource = {
    readAccess: async (r) => {
      calls.push(r);
      const answer = answers.get(`${r.orgId} ${r.memberId} ${r.repositoryId}`);
      if (answer === undefined) return { access: "none", reason: "not_found" };
      return typeof answer === "function" ? answer() : answer;
    },
  };
  return {
    source,
    calls,
    set: (
      r: RepositoryAccessRequest,
      answer: RepositoryAccessAnswer | (() => Promise<RepositoryAccessAnswer>),
    ) => {
      answers.set(`${r.orgId} ${r.memberId} ${r.repositoryId}`, answer);
    },
  };
};

const READ: RepositoryAccessAnswer = { access: "read" };
const REMOVED: RepositoryAccessAnswer = { access: "none", reason: "not_found" };

describe("P3-6 criterion: a user removed from the repo loses access within 5 minutes", () => {
  it("allows until exactly 5 minutes after the forge was asked, then denies, and never allows again", async () => {
    const c = clock();
    const gh = scripted();
    const access = createRepositoryAccessCheck({ source: gh.source, clock: c });
    gh.set(req(), READ);

    const first = await access.check(req());
    expect(first).toEqual({
      allowed: true,
      cached: false,
      expiresAt: new Date(T0 + ACCESS_MAX_TTL_MS),
    });

    // Removed on GitHub one second later.
    c.advance(1_000);
    gh.set(req(), REMOVED);

    c.set(T0 + ACCESS_MAX_TTL_MS - 1);
    expect(await access.check(req())).toMatchObject({ allowed: true, cached: true });
    expect(gh.calls).toHaveLength(1);

    c.set(T0 + ACCESS_MAX_TTL_MS);
    expect(await access.check(req())).toEqual({
      allowed: false,
      reason: "not_found",
      cached: false,
    });
    expect(gh.calls).toHaveLength(2);

    for (const later of [1, 1_000, DENY_TTL_MS, ACCESS_MAX_TTL_MS, 3_600_000]) {
      c.set(T0 + ACCESS_MAX_TTL_MS + later);
      expect((await access.check(req())).allowed).toBe(false);
    }
  });

  it("counts the 5 minutes from before the question, so a slow answer does not extend them", async () => {
    const c = clock();
    const gh = scripted();
    const access = createRepositoryAccessCheck({ source: gh.source, clock: c });
    gh.set(req(), async () => {
      c.advance(9_000); // GitHub takes 9 s; the removal happens while it answers.
      return READ;
    });
    const first = await access.check(req());
    expect(first).toMatchObject({ allowed: true, expiresAt: new Date(T0 + ACCESS_MAX_TTL_MS) });
    gh.set(req(), REMOVED);
    c.set(T0 + ACCESS_MAX_TTL_MS);
    expect((await access.check(req())).allowed).toBe(false);
  });

  it("an allow that arrives after its own expiry is a deny and is not cached", async () => {
    const c = clock();
    const gh = scripted();
    const access = createRepositoryAccessCheck({ source: gh.source, clock: c });
    gh.set(req(), async () => {
      c.advance(ACCESS_MAX_TTL_MS);
      return READ;
    });
    expect(await access.check(req())).toEqual({
      allowed: false,
      reason: "forge_unavailable",
      cached: false,
    });
    expect(access.size).toBe(0);
  });

  it("a shorter configured lifetime is honoured; longer than 5 minutes is refused", async () => {
    const c = clock();
    const gh = scripted();
    gh.set(req(), READ);
    const access = createRepositoryAccessCheck({ source: gh.source, clock: c, allowTtlMs: 60_000 });
    await access.check(req());
    c.set(T0 + 59_999);
    expect((await access.check(req())).cached).toBe(true);
    c.set(T0 + 60_000);
    expect((await access.check(req())).cached).toBe(false);
    for (const allowTtlMs of [ACCESS_MAX_TTL_MS + 1, 0, -1, 1.5, Number.NaN, Infinity]) {
      expect(() =>
        createRepositoryAccessCheck({ source: gh.source, clock: c, allowTtlMs }),
      ).toThrow();
    }
  });

  it("a clock that goes backwards does not keep an allow alive", async () => {
    const c = clock();
    const gh = scripted();
    gh.set(req(), READ);
    const access = createRepositoryAccessCheck({ source: gh.source, clock: c });
    await access.check(req());
    gh.set(req(), REMOVED);
    c.set(T0 - 1);
    expect((await access.check(req())).allowed).toBe(false);
  });

  it("an unreadable clock is a deny", async () => {
    const gh = scripted();
    gh.set(req(), READ);
    const access = createRepositoryAccessCheck({
      source: gh.source,
      clock: { now: () => new Date(Number.NaN) },
    });
    expect(await access.check(req())).toMatchObject({ allowed: false, reason: "error" });
  });
});

describe("outage: a cached allow is never extended", () => {
  it("serves the allow until its expiry during an outage, then denies", async () => {
    const c = clock();
    let down = false;
    const access = createRepositoryAccessCheck({
      clock: c,
      source: {
        readAccess: async () => {
          if (down) throw new ForgeReadError("http_status", 503);
          return READ;
        },
      },
    });
    expect((await access.check(req())).allowed).toBe(true);
    down = true;
    c.set(T0 + ACCESS_MAX_TTL_MS - 1);
    expect((await access.check(req())).allowed).toBe(true);
    c.set(T0 + ACCESS_MAX_TTL_MS);
    expect(await access.check(req())).toMatchObject({
      allowed: false,
      reason: "forge_unavailable",
    });
    // The outage deny is reused only briefly; recovery restores access after it.
    down = false;
    c.advance(TRANSIENT_DENY_TTL_MS - 1);
    expect((await access.check(req())).allowed).toBe(false);
    c.advance(1);
    expect((await access.check(req())).allowed).toBe(true);
  });
});

describe("fail closed", () => {
  const cases: [string, () => Promise<unknown>, AccessDenyReason][] = [
    ["timeout", () => Promise.reject(new ForgeReadError("timeout")), "forge_unavailable"],
    ["network", () => Promise.reject(new ForgeReadError("network")), "forge_unavailable"],
    ["5xx", () => Promise.reject(new ForgeReadError("http_status", 502)), "forge_unavailable"],
    ["429", () => Promise.reject(new ForgeReadError("http_status", 429)), "forge_unavailable"],
    [
      "bad answer",
      () => Promise.reject(new ForgeReadError("invalid_response")),
      "invalid_response",
    ],
    ["any error", () => Promise.reject(new Error("boom")), "error"],
    ["a thrown non-error", () => Promise.reject("boom"), "error"],
    ["undefined", () => Promise.resolve(undefined), "invalid_response"],
    ["null", () => Promise.resolve(null), "invalid_response"],
    ["true", () => Promise.resolve(true), "invalid_response"],
    ["a string", () => Promise.resolve("read"), "invalid_response"],
    ["access yes", () => Promise.resolve({ access: "yes" }), "invalid_response"],
    [
      "read plus extras",
      () => Promise.resolve({ access: "read", reason: "x" }),
      "invalid_response",
    ],
    [
      "unknown reason",
      () => Promise.resolve({ access: "none", reason: "nope" }),
      "invalid_response",
    ],
    ["allowed: true", () => Promise.resolve({ allowed: true }), "invalid_response"],
    [
      "synchronous throw",
      () => {
        throw new Error("sync");
      },
      "error",
    ],
  ];
  for (const [name, answer, reason] of cases) {
    it(`denies on ${name}`, async () => {
      const access = createRepositoryAccessCheck({
        clock: clock(),
        source: { readAccess: answer as RepositoryAccessSource["readAccess"] },
      });
      expect(await access.check(req())).toEqual({ allowed: false, reason, cached: false });
    });
  }

  it("passes every documented denial through", async () => {
    for (const reason of ACCESS_DENY_REASONS) {
      const access = createRepositoryAccessCheck({
        clock: clock(),
        source: { readAccess: () => Promise.resolve({ access: "none", reason }) },
      });
      expect(await access.check(req())).toMatchObject({ allowed: false, reason });
    }
  });

  it("denies malformed requests without asking or caching", async () => {
    const gh = scripted();
    const access = createRepositoryAccessCheck({ source: gh.source, clock: clock() });
    const bad: unknown[] = [
      null,
      undefined,
      "x",
      { orgId: "not-a-uuid", memberId: ALICE, repositoryId: REPO },
      { orgId: ORG_A, memberId: `${ALICE} 1`, repositoryId: REPO },
      { orgId: ORG_A, memberId: ALICE, repositoryId: 0 },
      { orgId: ORG_A, memberId: ALICE, repositoryId: -1 },
      { orgId: ORG_A, memberId: ALICE, repositoryId: 1.5 },
      { orgId: ORG_A, memberId: ALICE, repositoryId: "77" },
      { orgId: ORG_A, memberId: ALICE, repositoryId: Number.MAX_SAFE_INTEGER + 1 },
      {
        get orgId(): string {
          throw new Error("getter");
        },
        memberId: ALICE,
        repositoryId: REPO,
      },
    ];
    for (const request of bad) {
      expect(await access.check(request as RepositoryAccessRequest)).toEqual({
        allowed: false,
        reason: "invalid_request",
        cached: false,
      });
    }
    expect(gh.calls).toHaveLength(0);
    expect(access.size).toBe(0);
  });

  it("an observer that throws does not change the decision", async () => {
    const gh = scripted();
    gh.set(req(), READ);
    const access = createRepositoryAccessCheck({
      source: gh.source,
      clock: clock(),
      onDecision: () => {
        throw new Error("observer");
      },
    });
    expect((await access.check(req())).allowed).toBe(true);
    expect((await access.check(req())).allowed).toBe(true);
  });
});

describe("deny caching", () => {
  it("reuses a definitive deny for 30 s and a transient one for 5 s", async () => {
    const c = clock();
    let answer: () => Promise<RepositoryAccessAnswer> = () => Promise.resolve(REMOVED);
    const calls: number[] = [];
    const access = createRepositoryAccessCheck({
      clock: c,
      source: { readAccess: () => (calls.push(1), answer()) },
    });
    await access.check(req());
    c.set(T0 + DENY_TTL_MS - 1);
    expect(await access.check(req())).toMatchObject({ allowed: false, cached: true });
    c.set(T0 + DENY_TTL_MS);
    answer = () => Promise.reject(new ForgeReadError("timeout"));
    expect(await access.check(req())).toMatchObject({ allowed: false, cached: false });
    const t1 = T0 + DENY_TTL_MS;
    c.set(t1 + TRANSIENT_DENY_TTL_MS - 1);
    expect((await access.check(req())).cached).toBe(true);
    c.set(t1 + TRANSIENT_DENY_TTL_MS);
    answer = () => Promise.resolve(READ);
    expect(await access.check(req())).toMatchObject({ allowed: true, cached: false });
    expect(calls).toHaveLength(3);
  });

  it("a forbidden answer (SSO, rate limit) is transient", async () => {
    const c = clock();
    const access = createRepositoryAccessCheck({
      clock: c,
      source: { readAccess: () => Promise.resolve({ access: "none", reason: "forbidden" }) },
    });
    await access.check(req());
    expect(access.entries()[0]?.expiresAt).toEqual(new Date(T0 + TRANSIENT_DENY_TTL_MS));
  });
});

describe("cache isolation", () => {
  it("one member's allow never answers for another member, org or repository", async () => {
    const gh = scripted();
    const access = createRepositoryAccessCheck({ source: gh.source, clock: clock() });
    gh.set(req(ORG_A, ALICE, REPO), READ);
    expect((await access.check(req(ORG_A, ALICE, REPO))).allowed).toBe(true);
    // Same member uuid under another org, another member of the same org, another repo.
    expect((await access.check(req(ORG_B, ALICE, REPO))).allowed).toBe(false);
    expect((await access.check(req(ORG_A, BOB, REPO))).allowed).toBe(false);
    expect((await access.check(req(ORG_A, ALICE, REPO + 1))).allowed).toBe(false);
    expect(gh.calls.map((r) => [r.orgId, r.memberId, r.repositoryId])).toEqual([
      [ORG_A, ALICE, REPO],
      [ORG_B, ALICE, REPO],
      [ORG_A, BOB, REPO],
      [ORG_A, ALICE, REPO + 1],
    ]);
    expect(access.size).toBe(4);
  });

  it("upper- and lower-case uuids are one entry, and the source gets the normalised ids", async () => {
    const gh = scripted();
    gh.set(req(), READ);
    const access = createRepositoryAccessCheck({ source: gh.source, clock: clock() });
    await access.check(req());
    const upper = await access.check(req(ORG_A.toUpperCase() as OrgId, ALICE.toUpperCase()));
    expect(upper).toMatchObject({ allowed: true, cached: true });
    expect(access.size).toBe(1);
  });

  it("concurrent checks for one key share one forge call; different keys do not", async () => {
    const gh = scripted();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    gh.set(req(), async () => {
      await gate;
      return READ;
    });
    const access = createRepositoryAccessCheck({ source: gh.source, clock: clock() });
    const pending = [access.check(req()), access.check(req()), access.check(req(ORG_A, BOB))];
    release();
    const [a, b, c] = await Promise.all(pending);
    expect(a?.allowed).toBe(true);
    expect(b?.allowed).toBe(true);
    expect(c?.allowed).toBe(false);
    expect(gh.calls).toHaveLength(2);
  });
});

describe("size bound", () => {
  it("never holds more than maxEntries and evicts the least recently used", async () => {
    const gh = scripted();
    const access = createRepositoryAccessCheck({
      source: gh.source,
      clock: clock(),
      maxEntries: 3,
    });
    for (const repo of [1, 2, 3]) gh.set(req(ORG_A, ALICE, repo), READ);
    await access.check(req(ORG_A, ALICE, 1));
    await access.check(req(ORG_A, ALICE, 2));
    await access.check(req(ORG_A, ALICE, 3));
    await access.check(req(ORG_A, ALICE, 1)); // 1 is now the most recent
    for (let repo = 100; repo < 200; repo++) {
      await access.check(req(ORG_A, ALICE, repo));
      expect(access.size).toBeLessThanOrEqual(3);
    }
    await access.check(req(ORG_A, ALICE, 1));
    expect(gh.calls.filter((r) => r.repositoryId === 1)).toHaveLength(2);
  });

  it("evicts in recency order", async () => {
    const gh = scripted();
    const access = createRepositoryAccessCheck({
      source: gh.source,
      clock: clock(),
      maxEntries: 2,
    });
    await access.check(req(ORG_A, ALICE, 1));
    await access.check(req(ORG_A, ALICE, 2));
    await access.check(req(ORG_A, ALICE, 1));
    await access.check(req(ORG_A, ALICE, 3)); // evicts 2
    expect(access.entries().map((e) => e.repositoryId)).toEqual([1, 3]);
  });

  it("refuses an unbounded or empty cache", () => {
    const gh = scripted();
    for (const maxEntries of [0, -1, 1.5, Infinity, 1_000_001]) {
      expect(() =>
        createRepositoryAccessCheck({ source: gh.source, clock: clock(), maxEntries }),
      ).toThrow();
    }
  });
});

describe("invalidation", () => {
  const setup = async () => {
    const gh = scripted();
    for (const r of [
      req(ORG_A, ALICE, 1),
      req(ORG_A, ALICE, 2),
      req(ORG_A, BOB, 1),
      req(ORG_B, ALICE, 1),
    ]) {
      gh.set(r, READ);
    }
    const access = createRepositoryAccessCheck({ source: gh.source, clock: clock() });
    for (const r of [
      req(ORG_A, ALICE, 1),
      req(ORG_A, ALICE, 2),
      req(ORG_A, BOB, 1),
      req(ORG_B, ALICE, 1),
    ]) {
      await access.check(r);
    }
    const keys = () =>
      access
        .entries()
        .map(
          (e) =>
            `${e.orgId === ORG_A ? "A" : "B"}:${e.memberId === ALICE ? "alice" : "bob"}:${e.repositoryId}`,
        );
    return { access, keys };
  };

  it("invalidateMember drops one member of one org only", async () => {
    const { access, keys } = await setup();
    access.invalidateMember(ORG_A, ALICE.toUpperCase());
    expect(keys()).toEqual(["A:bob:1", "B:alice:1"]);
  });

  it("invalidateRepository drops one repository of one org only", async () => {
    const { access, keys } = await setup();
    access.invalidateRepository(ORG_A, 1);
    expect(keys()).toEqual(["A:alice:2", "B:alice:1"]);
  });

  it("invalidateOrg and clear", async () => {
    const { access, keys } = await setup();
    access.invalidateOrg(ORG_A);
    expect(keys()).toEqual(["B:alice:1"]);
    access.clear();
    expect(access.size).toBe(0);
  });

  it("a check in flight during an invalidation does not write its answer", async () => {
    const gh = scripted();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    gh.set(req(), async () => {
      await gate;
      return READ;
    });
    const access = createRepositoryAccessCheck({ source: gh.source, clock: clock() });
    const pending = access.check(req());
    access.invalidateMember(ORG_A, ALICE);
    // A new caller after the invalidation does not join the old flight.
    gh.set(req(), REMOVED);
    const after = await access.check(req());
    release();
    await pending;
    expect(after.allowed).toBe(false);
    expect(access.entries().map((e) => e.allowed)).toEqual([false]);
    expect(gh.calls).toHaveLength(2);
  });
});

describe("observability", () => {
  it("reports ids and fixed codes only", async () => {
    const events: AccessDecisionEvent[] = [];
    const gh = scripted();
    gh.set(req(), READ);
    const access = createRepositoryAccessCheck({
      source: gh.source,
      clock: clock(),
      onDecision: (e) => events.push(e),
    });
    await access.check(req());
    await access.check(req());
    await access.check(req(ORG_A, BOB));
    expect(events).toEqual([
      {
        orgId: ORG_A,
        memberId: ALICE,
        repositoryId: REPO,
        allowed: true,
        reason: null,
        cached: false,
        joined: false,
      },
      {
        orgId: ORG_A,
        memberId: ALICE,
        repositoryId: REPO,
        allowed: true,
        reason: null,
        cached: true,
        joined: false,
      },
      {
        orgId: ORG_A,
        memberId: BOB,
        repositoryId: REPO,
        allowed: false,
        reason: "not_found",
        cached: false,
        joined: false,
      },
    ]);
    expect(Object.keys(access.entries()[0] ?? {}).sort()).toEqual([
      "allowed",
      "checkedAt",
      "expiresAt",
      "memberId",
      "orgId",
      "reason",
      "repositoryId",
    ]);
  });
});

describe("review round 1", () => {
  const orgB1 = req(ORG_B, ALICE, 1);
  const seeded = async () => {
    const gh = scripted();
    const all = [req(ORG_A, ALICE, 1), req(ORG_A, BOB, 2), orgB1];
    for (const r of all) gh.set(r, READ);
    const access = createRepositoryAccessCheck({ source: gh.source, clock: clock() });
    for (const r of all) await access.check(r);
    const orgs = () => access.entries().map((e) => (e.orgId === ORG_A ? "A" : "B"));
    return { access, orgs, gh };
  };

  describe("C: invalidation hooks validate their input and fail closed", () => {
    it("valid input returns true and drops only what it names", async () => {
      const { access, orgs } = await seeded();
      expect(access.invalidateMember(ORG_A, BOB)).toBe(true);
      expect(orgs()).toEqual(["A", "B"]);
    });

    it("an invalid member id drops the whole org", async () => {
      for (const bad of ["not-a-uuid", "", 42, null, undefined, {}]) {
        const { access, orgs } = await seeded();
        expect(access.invalidateMember(ORG_A, bad as string)).toBe(false);
        expect(orgs()).toEqual(["B"]);
      }
    });

    it("an invalid repository id (string, bigint, float, zero) drops the whole org", async () => {
      for (const bad of ["1", 1n, 1.5, 0, -1, Number.NaN, null]) {
        const { access, orgs } = await seeded();
        expect(access.invalidateRepository(ORG_A, bad as number)).toBe(false);
        expect(orgs()).toEqual(["B"]);
      }
    });

    it("an invalid org id clears the whole cache, for every hook", async () => {
      const hooks: ((a: ReturnType<typeof createRepositoryAccessCheck>) => boolean)[] = [
        (a) => a.invalidateMember("nope", ALICE),
        (a) => a.invalidateMember(42 as unknown as string, ALICE),
        (a) => a.invalidateRepository("nope", 1),
        (a) => a.invalidateRepository(undefined as unknown as string, 1),
        (a) => a.invalidateOrg("nope"),
        (a) => a.invalidateOrg(ORG_A.replace(/-/g, "")),
        (a) => a.invalidateOrg(null as unknown as string),
      ];
      for (const hook of hooks) {
        const { access } = await seeded();
        expect(hook(access)).toBe(false);
        expect(access.size).toBe(0);
      }
    });

    it("upper-case ids are accepted and normalised", async () => {
      const { access, orgs } = await seeded();
      expect(access.invalidateRepository(ORG_A.toUpperCase(), 1)).toBe(true);
      expect(access.invalidateOrg(ORG_B.toUpperCase())).toBe(true);
      expect(orgs()).toEqual(["A"]);
    });

    it("an invalid id also stops that org's in-flight checks from caching", async () => {
      const gh = scripted();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      gh.set(req(), async () => {
        await gate;
        return READ;
      });
      const access = createRepositoryAccessCheck({ source: gh.source, clock: clock() });
      const pending = access.check(req());
      access.invalidateRepository(ORG_A, "77" as unknown as number);
      release();
      expect((await pending).allowed).toBe(true);
      expect(access.size).toBe(0);
    });
  });

  describe("D: the invalidation generation is per org", () => {
    const gated = () => {
      const gh = scripted();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const slow = async () => {
        await gate;
        return READ;
      };
      gh.set(req(ORG_A, ALICE), slow);
      gh.set(req(ORG_A, BOB), slow);
      gh.set(req(ORG_B, ALICE), slow);
      const access = createRepositoryAccessCheck({ source: gh.source, clock: clock() });
      return { access, release: () => release() };
    };

    it("an invalidation in org A does not stop org B's in-flight check from caching", async () => {
      const { access, release } = gated();
      const a = access.check(req(ORG_A, BOB));
      const b = access.check(req(ORG_B, ALICE));
      access.invalidateMember(ORG_A, ALICE); // another member of org A
      release();
      await Promise.all([a, b]);
      // Within org A the guarantee stays org-wide; org B is untouched.
      expect(access.entries().map((e) => e.orgId)).toEqual([ORG_B]);
    });

    it("invalidateOrg(A) and clear() keep their guarantees", async () => {
      {
        const { access, release } = gated();
        const pending = [access.check(req(ORG_A, ALICE)), access.check(req(ORG_B, ALICE))];
        access.invalidateOrg(ORG_A);
        release();
        await Promise.all(pending);
        expect(access.entries().map((e) => e.orgId)).toEqual([ORG_B]);
      }
      {
        const { access, release } = gated();
        const pending = [access.check(req(ORG_A, ALICE)), access.check(req(ORG_B, ALICE))];
        access.clear();
        release();
        await Promise.all(pending);
        expect(access.size).toBe(0);
      }
    });

    const orgN = (i: number) => `0b6f1c1e-3333-4a5b-8c9d-${String(i).padStart(12, "0")}`;

    it("S1 (ABA): a table reset never lets an in-flight check cache across an invalidation", async () => {
      // Generations are shown as "global:A".
      for (const variant of ["reset-to-start", "real-aba"] as const) {
        const gh = scripted();
        let release: () => void = () => undefined;
        const gate = new Promise<void>((r) => (release = r));
        gh.set(req(), async () => {
          await gate;
          return READ;
        });
        const maxEntries = 3;
        const access = createRepositoryAccessCheck({
          source: gh.source,
          clock: clock(),
          maxEntries,
        });
        const reset = () => {
          // More than maxEntries other orgs: the table is reset and A's counter is forgotten.
          for (let i = 0; i <= maxEntries; i++) {
            access.invalidateOrg(orgN(i));
            expect(access.generationTableSize).toBeLessThanOrEqual(maxEntries);
          }
        };
        let pending: Promise<unknown>;
        if (variant === "reset-to-start") {
          pending = access.check(req()); // starts at "0:0"
          access.invalidateOrg(ORG_A); // "0:1"
          reset(); // A forgotten: would read "0:0" again without the global bump
        } else {
          access.invalidateOrg(ORG_A); // "0:1"
          pending = access.check(req()); // starts at "0:1"
          reset(); // A forgotten
          access.invalidateOrg(ORG_A); // back to "0:1" without the global bump
        }
        release();
        expect(((await pending) as { allowed: boolean }).allowed).toBe(true);
        expect(access.size, variant).toBe(0);
        expect(access.generationTableSize).toBeLessThanOrEqual(maxEntries);
      }
    });

    it("the per-org generation table stays bounded", async () => {
      const gh = scripted();
      const access = createRepositoryAccessCheck({
        source: gh.source,
        clock: clock(),
        maxEntries: 4,
      });
      for (let i = 0; i < 50; i++) {
        const org = `0b6f1c1e-1111-4a5b-8c9d-${String(i).padStart(12, "0")}`;
        access.invalidateOrg(org);
        expect(access.generationTableSize).toBeLessThanOrEqual(4);
      }
      gh.set(req(), READ);
      expect((await access.check(req())).allowed).toBe(true);
      expect(access.size).toBe(1);
    });
  });

  describe("E: every caller gets a decision event", () => {
    it("joined callers are reported with joined: true", async () => {
      const events: AccessDecisionEvent[] = [];
      const gh = scripted();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      gh.set(req(), async () => {
        await gate;
        return READ;
      });
      const access = createRepositoryAccessCheck({
        source: gh.source,
        clock: clock(),
        onDecision: (e) => events.push(e),
      });
      const pending = [access.check(req()), access.check(req()), access.check(req())];
      release();
      await Promise.all(pending);
      expect(events.map((e) => [e.allowed, e.cached, e.joined])).toEqual([
        [true, false, false],
        [true, false, true],
        [true, false, true],
      ]);
    });
  });

  describe("new definitive denials", () => {
    for (const reason of ["token_user_mismatch", "not_collaborator", "no_installation"] as const) {
      it(`${reason} is a definitive deny (30 s)`, async () => {
        const access = createRepositoryAccessCheck({
          clock: clock(),
          source: { readAccess: () => Promise.resolve({ access: "none", reason }) },
        });
        expect(await access.check(req())).toMatchObject({ allowed: false, reason });
        expect(access.entries()[0]?.expiresAt).toEqual(new Date(T0 + DENY_TTL_MS));
      });
    }
  });
});
