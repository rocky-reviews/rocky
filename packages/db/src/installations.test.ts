import type { OrgId } from "@rocky-reviews/core";
import { describe, expect, it } from "vitest";
import type { TenantTx } from "./client.js";
import {
  beginOrgErasure,
  bindInstallation,
  cancelOrgDeletion,
  insertInstallationOrg,
  scheduleOrgDeletion,
} from "./installations.js";

/** P3-3: the org writes refuse malformed values before any SQL (the database re-checks). */

const recordingTx = () => {
  const statements: unknown[][] = [];
  const tx = {
    orgId: "00000000-0000-4000-8000-000000000001" as OrgId,
    query: (text: string, values: unknown[] = []) => {
      statements.push([text, ...values]);
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as TenantTx;
  return { tx, statements };
};

const good = {
  forge: "github" as const,
  installationId: 1,
  accountId: 2,
  login: "acme",
  kind: "organization" as const,
  installerForgeUserId: null,
};

describe("insertInstallationOrg / bindInstallation", () => {
  it("refuse malformed ids, logins and kinds before any SQL", async () => {
    const { tx, statements } = recordingTx();
    for (const org of [
      { ...good, installationId: 0 },
      { ...good, accountId: -1 },
      { ...good, accountId: 1.5 },
      { ...good, installerForgeUserId: 0 },
      { ...good, login: "../etc" },
      { ...good, login: "a".repeat(101) },
      { ...good, kind: "enterprise" as never },
    ]) {
      await expect(insertInstallationOrg(tx, org), JSON.stringify(org)).rejects.toThrow(/^org:/);
    }
    for (const options of [
      { expectedInstallationId: 0, installationId: 1, login: "a", kind: "user" as const },
      { expectedInstallationId: 1, installationId: 1, login: "a b", kind: "user" as const },
      { expectedInstallationId: 1, installationId: 1, login: "a", kind: "team" as never },
    ]) {
      await expect(bindInstallation(tx, options)).rejects.toThrow(/^org:/);
    }
    expect(statements).toEqual([]);
  });

  it("scope every write to the transaction's own org and report no-ops", async () => {
    const { tx, statements } = recordingTx();
    await insertInstallationOrg(tx, good);
    expect(
      await bindInstallation(tx, {
        expectedInstallationId: 1,
        installationId: 3,
        login: "acme",
        kind: "organization",
      }),
    ).toBe(false);
    // Nothing matched and the org is not (or no longer) bound to that installation.
    expect(await scheduleOrgDeletion(tx, 1)).toBe("stale");
    expect(await cancelOrgDeletion(tx)).toBe(false);
    expect(await beginOrgErasure(tx)).toBe("not_due");
    expect(statements.length).toBeGreaterThan(4);
    for (const s of statements) expect(s[1]).toBe(tx.orgId);
  });
});
