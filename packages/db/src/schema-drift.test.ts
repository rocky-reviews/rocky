import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { CONTAINER_TIMEOUT_MS, startPostgres } from "./testing/index.js";

/**
 * The SQL migrations are the source of truth; the Drizzle schema is a typed mirror. This keeps
 * them from drifting: every Drizzle table and column exists with the same name and nullability,
 * and every database column is declared in Drizzle.
 */

let pgs: Awaited<ReturnType<typeof startPostgres>>;

beforeAll(async () => {
  pgs = await startPostgres();
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await pgs?.stop();
});

const drizzleTables = (): PgTable[] =>
  Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => is(v, PgTable));

describe("Drizzle schema vs migrations", () => {
  it("declares every table in public, and nothing else", async () => {
    const { rows } = await pgs.migrator.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    const declared = drizzleTables()
      .map((t) => getTableConfig(t).name)
      .sort();
    expect(declared).toEqual(rows.map((r) => r.table_name));
  });

  it("matches column names and nullability for every table", async () => {
    for (const table of drizzleTables()) {
      const config = getTableConfig(table);
      const { rows } = await pgs.migrator.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = $1 order by column_name`,
        [config.name],
      );
      const actual = rows.map(
        (r) => `${r.column_name}:${r.is_nullable === "NO" ? "not null" : "null"}`,
      );
      const declared = config.columns
        .map((c) => `${c.name}:${c.notNull ? "not null" : "null"}`)
        .sort();
      expect(declared, config.name).toEqual(actual);
    }
  });
});
