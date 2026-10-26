import type { OrgId } from "@rocky-reviews/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, TenantContextError, type Db } from "./client.js";
import * as schema from "./schema.js";
import {
  asWorker,
  CONTAINER_TIMEOUT_MS,
  newOrgId,
  seedOrg,
  startPostgres,
} from "./testing/index.js";

/** P2-2: the tenant-scoped client. The isolation suite covers the policies table by table. */

let pgs: Awaited<ReturnType<typeof startPostgres>>;
let pool: pg.Pool;
let db: Db;
let orgA: OrgId;
let orgB: OrgId;

beforeAll(async () => {
  pgs = await startPostgres();
  // One physical connection, so "stale session state" tests hit the same connection withOrg uses.
  pool = new pg.Pool({ connectionString: pgs.appUrl, max: 1 });
  db = createDb({ pool });
  orgA = newOrgId();
  orgB = newOrgId();
  await asWorker(pgs.workerUrl, async (w) => {
    await seedOrg(w, orgA);
    await seedOrg(w, orgB);
  });
}, CONTAINER_TIMEOUT_MS);

afterAll(async () => {
  await db?.close();
  await pgs?.stop();
});

const repoOrgIds = async (orgId: OrgId): Promise<string[]> =>
  db.withOrg(orgId, async (tx) => (await tx.db.select().from(schema.repos)).map((r) => r.orgId));

describe("withOrg", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** A regression here would hold the connection forever; fail fast instead of hanging the suite. */
  const withTimeout = <T>(promise: Promise<T>, ms = 5_000): Promise<T> =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms),
      ),
    ]);

  const contentsOf = async (orgId: OrgId): Promise<string[]> =>
    db.withOrg(orgId, async (tx) =>
      (await tx.db.select({ c: schema.memoryEntries.content }).from(schema.memoryEntries)).map(
        (r) => r.c,
      ),
    );

  it("scopes Drizzle and raw queries to the org", async () => {
    expect(await repoOrgIds(orgA)).toEqual([orgA]);
    await db.withOrg(orgB, async (tx) => {
      const raw = await tx.query<{ org_id: string }>("select org_id from repos");
      expect(raw.rows).toEqual([{ org_id: orgB }]);
      expect(tx.orgId).toBe(orgB);
    });
  });

  it("rejects an org id that is not a uuid before touching the database", async () => {
    const fn = async () => Promise.resolve("never");
    await expect(db.withOrg("" as OrgId, fn)).rejects.toThrow(TenantContextError);
    await expect(db.withOrg("' or 1=1 --" as OrgId, fn)).rejects.toThrow(TenantContextError);
    await expect(db.withOrg("00000000-0000-0000-0000-00000000000g" as OrgId, fn)).rejects.toThrow(
      TenantContextError,
    );
  });

  it("commits on success and rolls back when fn throws", async () => {
    await db.withOrg(orgA, async (tx) => {
      await tx.db.insert(schema.memoryEntries).values({ kind: "note", content: "committed" });
    });
    await expect(
      db.withOrg(orgA, async (tx) => {
        await tx.db.insert(schema.memoryEntries).values({ kind: "note", content: "rolled back" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const contents = await db.withOrg(orgA, async (tx) =>
      (await tx.db.select({ c: schema.memoryEntries.content }).from(schema.memoryEntries)).map(
        (r) => r.c,
      ),
    );
    expect(contents).toContain("committed");
    expect(contents).not.toContain("rolled back");
  });

  it("does not leak a stale session-level app.org_id into or out of a transaction", async () => {
    await pool.query("select set_config('app.org_id', $1, false)", [orgB]);
    expect(await repoOrgIds(orgA)).toEqual([orgA]);
    // After withOrg the connection carries no tenant: a bare query sees nothing.
    const bare = await pool.query("select org_id from repos");
    expect(bare.rowCount).toBe(0);
    const setting = await pool.query<{ v: string | null }>(
      "select current_setting('app.org_id', true) as v",
    );
    expect(setting.rows[0]?.v ?? "").toBe("");
  });

  it("aborts the transaction if code inside it switches tenant", async () => {
    await expect(
      db.withOrg(orgA, async (tx) => {
        await tx.db.insert(schema.memoryEntries).values({ kind: "note", content: "pre-switch" });
        await tx.query("select set_config('app.org_id', $1, true)", [orgB]);
        return "should not commit";
      }),
    ).rejects.toThrow(TenantContextError);
    const contents = await db.withOrg(orgA, async (tx) =>
      (await tx.db.select({ c: schema.memoryEntries.content }).from(schema.memoryEntries)).map(
        (r) => r.c,
      ),
    );
    expect(contents).not.toContain("pre-switch");
    // RESET inside the transaction is a switch too (to "no tenant").
    await expect(
      db.withOrg(orgA, async (tx) => {
        await tx.query("reset app.org_id");
      }),
    ).rejects.toThrow(TenantContextError);
  });

  it("refuses a nested withOrg for a different org and keeps the outer scope intact", async () => {
    const seen = await db.withOrg(orgA, async (outer) => {
      await expect(db.withOrg(orgB, async () => Promise.resolve("inner"))).rejects.toThrow(
        TenantContextError,
      );
      return (await outer.db.select().from(schema.repos)).map((r) => r.orgId);
    });
    expect(seen).toEqual([orgA]);
  });

  it("joins a nested withOrg for the same org: one transaction, same tenant handle (re-review F)", async () => {
    await withTimeout(
      db.withOrg(orgA, async (outer) => {
        await outer.db.insert(schema.memoryEntries).values({ kind: "note", content: "outer" });
        await db.withOrg(orgA, async (inner) => {
          expect(inner.orgId).toBe(orgA);
          const rows = await inner.db.select().from(schema.memoryEntries);
          expect(rows.map((r) => r.content)).toContain("outer");
          await inner.db.insert(schema.memoryEntries).values({ kind: "note", content: "inner" });
        });
      }),
    );
    expect(await contentsOf(orgA)).toEqual(expect.arrayContaining(["outer", "inner"]));
  });

  it("rolls back the whole transaction when a nested failure is not caught", async () => {
    await expect(
      withTimeout(
        db.withOrg(orgA, async (outer) => {
          await outer.db
            .insert(schema.memoryEntries)
            .values({ kind: "note", content: "uncaught-outer" });
          await db.withOrg(orgA, async (inner) => {
            await inner.db
              .insert(schema.memoryEntries)
              .values({ kind: "note", content: "uncaught-inner" });
            throw new Error("inner boom");
          });
        }),
      ),
    ).rejects.toThrow("inner boom");
    const contents = await contentsOf(orgA);
    expect(contents).not.toContain("uncaught-outer");
    expect(contents).not.toContain("uncaught-inner");
  });

  it("leaves the outer transaction usable when the caller catches a nested failure; the nested writes stay (re-review F)", async () => {
    await withTimeout(
      db.withOrg(orgA, async (outer) => {
        await outer.db
          .insert(schema.memoryEntries)
          .values({ kind: "note", content: "caught-outer" });
        await expect(
          db.withOrg(orgA, async (inner) => {
            await inner.db
              .insert(schema.memoryEntries)
              .values({ kind: "note", content: "caught-inner" });
            throw new Error("inner boom");
          }),
        ).rejects.toThrow("inner boom");
        // REQUIRED propagation: no savepoint, so what the nested call wrote is still in this
        // transaction, and the transaction itself is fine.
        await outer.db
          .insert(schema.memoryEntries)
          .values({ kind: "note", content: "after-catch" });
        const rows = await outer.db
          .select({ c: schema.memoryEntries.content })
          .from(schema.memoryEntries);
        expect(rows.map((r) => r.c)).toContain("caught-inner");
      }),
    );
    expect(await contentsOf(orgA)).toEqual(
      expect.arrayContaining(["caught-outer", "caught-inner", "after-catch"]),
    );
  });

  it("can be created from a connection string and closed", async () => {
    const own = createDb({ connectionString: pgs.appUrl, max: 2 });
    const rows = await own.withOrg(orgB, async (tx) => tx.db.select().from(schema.orgs));
    expect(rows.map((r) => r.id)).toEqual([orgB]);
    await own.close();
  });

  it("refuses a detached nested withOrg whose enclosing transaction has finished (review #1)", async () => {
    // A timer scheduled inside withOrg(A) inherits A's async scope and fires after A committed,
    // while withOrg(B) holds the (single) pooled connection. Reusing A's scope would run the
    // query on B's connection, inside B's transaction.
    let detached: Promise<unknown> = Promise.resolve();
    await db.withOrg(orgA, async () => {
      detached = new Promise((resolve, reject) => {
        setTimeout(() => {
          db.withOrg(orgA, (tx) => tx.query<{ org_id: string }>("select org_id from repos")).then(
            resolve,
            reject,
          );
        }, 20);
      });
      // The rejection arrives before this test looks at it; keep Node from flagging it.
      detached.catch(() => undefined);
    });
    await db.withOrg(orgB, async () => {
      await sleep(80);
    });
    await expect(detached).rejects.toThrow(TenantContextError);
    await expect(detached).rejects.toThrow(/finished/);
  });

  it("refuses queries on a tx handle after its transaction ended (review #2)", async () => {
    const saved = await db.withOrg(orgA, async (tx) => tx);
    await db.withOrg(orgB, async () => {
      await expect(saved.query("select org_id from repos")).rejects.toThrow(TenantContextError);
      // Drizzle wraps driver errors; the TenantContextError is the cause.
      await expect(saved.db.select().from(schema.repos)).rejects.toMatchObject({
        cause: expect.any(TenantContextError) as unknown,
      });
    });
    await expect(saved.query("select 1")).rejects.toThrow(TenantContextError);
    // The connection itself is unaffected: a fresh transaction still works and sees only A.
    expect(await repoOrgIds(orgA)).toEqual([orgA]);
  });

  it("runs concurrent nested calls at the root on the shared transaction (review #6, re-review F)", async () => {
    await withTimeout(
      db.withOrg(orgA, async () => {
        await Promise.all(
          [1, 2, 3].map((n) =>
            db.withOrg(orgA, async (tx) => {
              await tx.db
                .insert(schema.memoryEntries)
                .values({ kind: "note", content: `par-${n}` });
              await sleep(5);
            }),
          ),
        );
      }),
    );
    expect(await contentsOf(orgA)).toEqual(expect.arrayContaining(["par-1", "par-2", "par-3"]));
  });

  it("nests three levels deep without deadlocking (re-review A)", async () => {
    const result = await withTimeout(
      db.withOrg(orgA, (l1) =>
        db.withOrg(orgA, (l2) =>
          db.withOrg(orgA, async (l3) => {
            await l3.db.insert(schema.memoryEntries).values({ kind: "note", content: "depth-3" });
            const rows = await l3.query<{ v: number }>("select 3 as v");
            expect(l1.orgId).toBe(orgA);
            expect(l2.orgId).toBe(orgA);
            return rows.rows[0]?.v;
          }),
        ),
      ),
    );
    expect(result).toBe(3);
    // An uncaught failure three levels down rolls back the whole transaction.
    await expect(
      withTimeout(
        db.withOrg(orgA, async (l1) => {
          await l1.db
            .insert(schema.memoryEntries)
            .values({ kind: "note", content: "depth-1-lost" });
          await db.withOrg(orgA, () =>
            db.withOrg(orgA, async (l3) => {
              await l3.db
                .insert(schema.memoryEntries)
                .values({ kind: "note", content: "depth-3-lost" });
              throw new Error("depth-3 boom");
            }),
          );
        }),
      ),
    ).rejects.toThrow("depth-3 boom");
    const contents = await contentsOf(orgA);
    expect(contents).toContain("depth-3");
    expect(contents).not.toContain("depth-1-lost");
    expect(contents).not.toContain("depth-3-lost");
  });

  it("refuses an orphan from a timer at depth and never touches the next tenant's transaction (re-review F)", async () => {
    // pool max=1 (beforeAll). A setTimeout(0) inside a level-2 withOrg outlives the root
    // transaction; by the time it fires, withOrg(B) owns the connection and is nesting too.
    const noop = () => undefined;
    let orphanCall: Promise<unknown> = Promise.resolve();
    let orphanQuery: Promise<unknown> = Promise.resolve();
    await withTimeout(
      db.withOrg(orgA, () =>
        db.withOrg(orgA, async (l2) => {
          orphanCall = new Promise((resolve, reject) => {
            setTimeout(() => {
              db.withOrg(orgA, (tx) => tx.query("select org_id from repos")).then(resolve, reject);
            }, 20);
          });
          orphanQuery = new Promise((resolve, reject) => {
            setTimeout(() => {
              l2.query("select org_id from repos").then(resolve, reject);
            }, 20);
          });
          orphanCall.catch(noop);
          orphanQuery.catch(noop);
        }),
      ),
    );
    const seenByB = await withTimeout(
      db.withOrg(orgB, async (outer) => {
        await db.withOrg(orgB, async (inner) => {
          await inner.db.insert(schema.memoryEntries).values({ kind: "note", content: "b-nested" });
        });
        await sleep(80);
        return (
          await outer.db.select({ c: schema.memoryEntries.content }).from(schema.memoryEntries)
        ).map((r) => r.c);
      }),
    );
    expect(seenByB).toContain("b-nested");
    await expect(orphanCall).rejects.toThrow(TenantContextError);
    await expect(orphanQuery).rejects.toThrow(TenantContextError);
    expect(await contentsOf(orgB)).toContain("b-nested");
    expect(await repoOrgIds(orgA)).toEqual([orgA]);
    expect(await repoOrgIds(orgB)).toEqual([orgB]);
  });

  it("nests inside one branch of a Promise.all without deadlocking (re-review A)", async () => {
    const results = await withTimeout(
      db.withOrg(orgA, () =>
        Promise.all([
          db.withOrg(orgA, (l2) =>
            db.withOrg(orgA, async (l3) => {
              await l3.db
                .insert(schema.memoryEntries)
                .values({ kind: "note", content: "branch-deep" });
              expect(l2.orgId).toBe(orgA);
              return "deep";
            }),
          ),
          db.withOrg(orgA, async (l2) => {
            await l2.db
              .insert(schema.memoryEntries)
              .values({ kind: "note", content: "branch-flat" });
            return "flat";
          }),
          db.withOrg(orgA, () =>
            db.withOrg(orgA, () => db.withOrg(orgA, async () => Promise.resolve("deeper"))),
          ),
        ]),
      ),
    );
    expect(results).toEqual(["deep", "flat", "deeper"]);
    const contents = await db.withOrg(orgA, async (tx) =>
      (await tx.db.select({ c: schema.memoryEntries.content }).from(schema.memoryEntries)).map(
        (r) => r.c,
      ),
    );
    expect(contents).toEqual(expect.arrayContaining(["branch-deep", "branch-flat"]));
  });

  it("exposes nothing of the pg client beyond query: release/connection/end throw (re-review C)", async () => {
    await db.withOrg(orgA, async (tx) => {
      const raw = (tx.db as unknown as { $client: Record<string, unknown> }).$client;
      expect(() => raw["release"]).toThrow(TenantContextError);
      expect(() => raw["connection"]).toThrow(TenantContextError);
      expect(() => raw["end"]).toThrow(TenantContextError);
      expect(() => raw["escapeLiteral"]).toThrow(TenantContextError);
      expect(typeof raw["query"]).toBe("function");
    });
    // The connection stayed inside the transaction: B still sees only B, A only A.
    expect(await repoOrgIds(orgB)).toEqual([orgB]);
    expect(await repoOrgIds(orgA)).toEqual([orgA]);
  });

  it("accepts legitimate statements the guard must not misread (re-review B)", async () => {
    await db.withOrg(orgA, async (tx) => {
      expect((await tx.query<{ v: string }>("select 'a;b' as v")).rows[0]?.v).toBe("a;b");
      expect((await tx.query<{ v: string }>("select 'it''s; fine' as v")).rows[0]?.v).toBe(
        "it's; fine",
      );
      expect((await tx.query<{ v: string }>("select $$x;y$$ as v")).rows[0]?.v).toBe("x;y");
      expect((await tx.query<{ v: string }>("select $q$a;b$q$ as v")).rows[0]?.v).toBe("a;b");
      expect((await tx.query<{ v: number }>("select 1 as v;")).rows[0]?.v).toBe(1);
      expect((await tx.query<{ v: number }>("select 1 as v; -- done")).rows[0]?.v).toBe(1);
      expect(
        (await tx.query<{ v: string }>("select current_setting('app.org_id') as v")).rows[0]?.v,
      ).toBe(orgA);
      expect((await tx.query<{ v: string }>("select '--not a comment' as v")).rows[0]?.v).toBe(
        "--not a comment",
      );
      expect((await tx.query<{ v: string }>(`select 'commit' as "v"`)).rows[0]?.v).toBe("commit");
      expect((await tx.query<{ v: string }>("select E'it\\'s; ok' as v")).rows[0]?.v).toBe(
        "it's; ok",
      );
      expect((await tx.query<Record<string, number>>("select 1 as a$x$")).rows[0]?.["a$x$"]).toBe(
        1,
      );
      // Final review: `do`, `create`, `call` and pg_settings only matter at the statement head.
      expect((await tx.query<{ do: number }>(`select 1 as "do"`)).rows[0]?.do).toBe(1);
      expect(
        (
          await tx.query(
            "insert into memory_entries (kind, content) values ('note', 'conflict') on conflict do nothing",
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (await tx.query<{ n: string }>("select count(*)::text as n from pg_catalog.pg_settings"))
          .rows[0]?.n,
      ).toMatch(/^\d+$/);
      expect((await tx.query<{ v: string }>("select 'create table x' as v")).rows[0]?.v).toBe(
        "create table x",
      );
    });
  });

  it("rejects transaction control and tenant-switching statements inside a tx (review #11)", async () => {
    const forbidden = [
      "commit",
      " COMMIT;",
      "end",
      "rollback",
      "abort",
      "begin",
      "start transaction",
      "savepoint x",
      "release savepoint x",
      "rollback to savepoint x",
      "prepare transaction 'x'",
      "set role rocky_retention",
      "SET LOCAL ROLE rocky_retention",
      "set session authorization rocky_retention",
      "reset role",
      "reset app.org_id",
      "reset all",
      "set local app.org_id = 'x'",
      "set app.org_id to 'x'",
      "select set_config('app.org_id', 'x', true)",
      "select pg_catalog.set_config( 'app.org_id' , $1, true)",
      "select set_config($1, $2, true)",
      "/* c */ commit",
      "-- c\ncommit",
      "select 1; commit",
      "discard all",
      "discard temp",
      // Bypasses found in re-review B: quoting, comments as whitespace, quoted parameter names.
      `select "set_config"('app.org_id', $1, true)`,
      "select set_config/**/('app.org_id', $1, true)",
      `select SET_CONFIG /* x */ ( 'app.org_id', $1, true )`,
      `set "app.org_id" = 'x'`,
      `set local "app"."org_id" to 'x'`,
      `SET SESSION "app" . "org_id" TO 'x'`,
      "select 1; commit; select 2",
      "select 'a'; commit",
      "(commit)",
      // Re-review G: E'' backslash escapes, u& escapes, identifiers that end in $tag$.
      "select E'\\'' as v; commit",
      `select u&"set_conf\\0069g"('app.org_id', $1, true)`,
      "select u&'x' as v; commit",
      "select 1 as a$x$; commit; select 'a$x$' as b",
      // Final review: procedural code and indirect set_config. The database refuses these too
      // (isolation.test.ts); the guard is the second layer.
      "do $x$ begin perform set_config('app.org_id', 'x', true); end $x$",
      "DO LANGUAGE plpgsql $$ begin null; end $$",
      "/* c */ do $$ begin null; end $$",
      "call public.p()",
      "create function public.f() returns int language sql as 'select 1'",
      "create or replace procedure public.p() language sql as 'select 1'",
      "create temp table t (id int)",
      "update pg_catalog.pg_settings set setting = 'x' where name = 'app.org_id'",
      "update pg_settings set setting = 'x' where name = 'app.org_id'",
      `update "pg_catalog" . "pg_settings" set setting = 'x'`,
      "alter role current_user set app.org_id = 'x'",
      "alter user current_user set search_path = public",
      "select ts_stat('select set_config(''app.org_id'', ''x'', true)::tsvector')",
      "select ts_stat /* x */ ('select 1', 'x')",
      "select ts_rewrite('a'::tsquery, 'select set_config(''app.org_id'', ''x'', true)::tsquery')",
      "select query_to_xml('select 1', false, false, '')",
      "select query_to_xmlschema('select 1', false, false, '')",
      "select pg_catalog.query_to_xml_and_xmlschema('select 1', false, false, '')",
    ];
    for (const sql of forbidden) {
      const params = (sql.match(/\$\d/g) ?? []).map(() => "x");
      await expect(
        db.withOrg(orgA, (tx) => tx.query(sql, params)),
        sql,
      ).rejects.toThrow(TenantContextError);
    }
    // Drizzle's own transaction() would BEGIN/COMMIT inside ours: refused too.
    await expect(
      db.withOrg(orgA, (tx) => tx.db.transaction(async () => Promise.resolve())),
    ).rejects.toMatchObject({ cause: expect.any(TenantContextError) as unknown });
    // Ordinary statements, including a harmless SET LOCAL, still work.
    await db.withOrg(orgA, async (tx) => {
      await tx.query("set local statement_timeout = '5s'");
      const rows = await tx.query<{ v: string }>("select current_setting('app.org_id') as v");
      expect(rows.rows[0]?.v).toBe(orgA);
    });
  });
});
