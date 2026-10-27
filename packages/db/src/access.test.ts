import { describe, expect, it } from "vitest";
import { loadRepositoryAccessContext } from "./access.js";
import type { TenantTx } from "./client.js";
import { SecretStoreError } from "./secrets.js";

/**
 * P3-6: input checks and error hygiene of the access-context read. The read itself, with RLS,
 * runs end to end in `apps/server/src/repository-access.db.test.ts`.
 */

const MEMBER = "5d1e9f00-aaaa-4bcd-9e00-000000000001";
const SECRET = "test-only-value-that-must-not-leak";

/** A transaction whose every query fails with a driver error quoting its parameters. */
const failingTx = {
  orgId: "0b6f1c1e-1111-4a5b-8c9d-000000000001",
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.reject(new Error(`syntax error near "${SECRET}"`)),
      }),
    }),
  },
  query: () => Promise.reject(new Error(SECRET)),
} as unknown as TenantTx;

describe("loadRepositoryAccessContext", () => {
  it("refuses malformed ids before any query", async () => {
    for (const request of [
      { memberId: "not-a-uuid", forgeRepoId: 1 },
      { memberId: `${MEMBER}'--`, forgeRepoId: 1 },
      { memberId: MEMBER, forgeRepoId: 0 },
      { memberId: MEMBER, forgeRepoId: 1.5 },
      { memberId: MEMBER, forgeRepoId: Number.NaN },
    ]) {
      await expect(loadRepositoryAccessContext(failingTx, request)).rejects.toBeInstanceOf(
        SecretStoreError,
      );
    }
  });

  it("a database error carries no statement values", async () => {
    const error = await loadRepositoryAccessContext(failingTx, {
      memberId: MEMBER,
      forgeRepoId: 77,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretStoreError);
    expect(String(error)).not.toContain(SECRET);
    expect((error as Error).message).toBe("access: database error");
  });
});
