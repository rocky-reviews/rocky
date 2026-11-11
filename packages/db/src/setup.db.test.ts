import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { checkDatabaseSetup, loadOrgSetupProgress } from "./setup.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  ignoreIdleError,
  newOrgId,
  seedOrg,
  startPostgres,
  type SeededOrg,
  type TestPostgres,
} from "./testing/index.js";

/**
 * P10-2 (ADR 0044): what the setup wizard reads, as the application login, against a real
 * Postgres: the schema check over the catalogue and one org's progress inside `withOrg`.
 */

let pgs: TestPostgres;
let empty: TestPostgres;
let db: Db;
let A: SeededOrg;

beforeAll(async () => {
  [pgs, empty] = await Promise.all([startPostgres(), startPostgres({ migrate: false })]);
  db = createDb({ connectionString: pgs.appUrl, max: 2 });
  A = await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 71 }));
  await asWorker(pgs.workerUrl, (w) => seedOrg(w, newOrgId(), { installationId: 72 }));
}, CONTAINER_TIMEOUT_MS * 2);

afterAll(async () => {
  await db?.close();
  await Promise.all([pgs?.stop(), empty?.stop()]);
});

const asApp = async <T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: url }).on("error", ignoreIdleError);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

describe("checkDatabaseSetup (P10-2)", () => {
  it("finds nothing missing on a migrated database, as the application login", async () => {
    const check = await asApp(pgs.appUrl, (c) => checkDatabaseSetup(c));
    expect(check).toEqual({ missingExtensions: [], missingSchema: [] });
  });

  it("names every table when no migration has run", async () => {
    const check = await asApp(empty.migratorUrl, (c) => checkDatabaseSetup(c));
    expect(check.missingExtensions).toEqual([]);
    expect(check.missingSchema).toContain("orgs");
    expect(check.missingSchema).toContain("analyses");
  });

  it("names a missing column and a missing extension", async () => {
    const answers = [
      { rows: [] },
      {
        rows: [
          { table_name: "orgs", column_name: "id" },
          { table_name: "repos", column_name: "id" },
        ],
      },
    ];
    const client = { query: async () => answers.shift() } as unknown as pg.Client;
    const check = await checkDatabaseSetup(client);
    expect(check.missingExtensions).toEqual(["vector"]);
    expect(check.missingSchema).toContain("orgs.installation_id");
    expect(check.missingSchema).toContain("repos.full_name");
    expect(check.missingSchema).toContain("analyses");
    expect(check.missingSchema).not.toContain("orgs.id");
  });
});

describe("loadOrgSetupProgress (P10-2)", () => {
  it("counts one org's repositories, pull requests and analyses, and names the latest done", async () => {
    const progress = await db.withOrg(A.orgId, (tx) => loadOrgSetupProgress(tx));
    expect(progress).toEqual({
      repositories: 1,
      pullRequests: 1,
      analyses: { queued: 0, running: 0, awaitingApproval: 0, done: 1, failed: 0 },
      latestDone: { fullName: "org-71/api", number: 847 },
    });
  });

  it("is empty for an org with nothing mirrored yet", async () => {
    const orgId = newOrgId();
    await asWorker(pgs.workerUrl, (w) =>
      w.withOrg(orgId, async ({ query }) => {
        await query(
          "insert into orgs (id, installation_id, account_id, login, kind) values ($1, 73, 1000073, 'org-73', 'organization')",
          [orgId],
        );
      }),
    );
    const progress = await db.withOrg(orgId, (tx) => loadOrgSetupProgress(tx));
    expect(progress).toEqual({
      repositories: 0,
      pullRequests: 0,
      analyses: { queued: 0, running: 0, awaitingApproval: 0, done: 0, failed: 0 },
      latestDone: null,
    });
  });
});
