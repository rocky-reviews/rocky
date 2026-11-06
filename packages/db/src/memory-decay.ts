import type { Clock, OrgId } from "@rocky-reviews/core";
import { audit } from "./audit.js";
import { MAX_LIVE_ORGS_PAGE, type Db, type TenantTx } from "./client.js";
import type { RetentionConfig } from "./retention-sql.js";
import {
  MEMORY_SUPERSEDED_MIN_RETENTION_DAYS,
  MEMORY_UNUSED_MIN_RETENTION_DAYS,
} from "./retention.js";

/**
 * Project memory decay (P8-4, migration 0019, ADR 0038). A scheduled job that, per org and inside
 * that org's `withOrg` transaction (RLS on `memory_entries` and `embeddings`; the explicit
 * `org_id` filters are defence in depth), applies three time-based rules to **learned** entries,
 * in this order:
 *
 * 1. **History:** a superseded learned entry is deleted `memorySupersededDays` after it was
 *    superseded (`updated_at`, stamped by the supersede), tail first: never while another entry
 *    still points at it.
 * 2. **Retire:** a current learned entry that no review has cited for `memoryUnusedDays` is
 *    deleted together with the learned entries it superseded (the chain behind it), because
 *    `superseded_by … ON DELETE SET NULL` would otherwise make the older entry current again. A
 *    chain that holds a member-written entry anywhere is left alone.
 * 3. **Decay:** a current learned entry that no review has cited for `memoryDecayDays` (since its
 *    last citation, its creation or its last decay step) loses `MEMORY_DECAY_STEP` confidence
 *    points, down to 0, and records the step in `decayed_at`, so a run takes at most one step per
 *    idle period.
 *
 * Member-written entries are never decayed, retired or purged, current or as history: a person
 * wrote them and P8-3 is where people edit and delete them. Deletion is permanent; the entries
 * are derived data (GitHub holds the reviews they came from).
 *
 * Each rule **locks first and never waits**: it selects its candidates `FOR UPDATE SKIP LOCKED`
 * with the rule's predicate (under READ COMMITTED the predicate is re-evaluated on the newest
 * row version, so an entry cited or superseded by a transaction that committed meanwhile drops
 * out; one a transaction still holds is left for the next run), then acts on exactly those ids
 * with a fresh snapshot. The chain behind a retiring head is locked the same way, and a chain
 * with a row held elsewhere is skipped whole. So the job never waits on a `memory_entries` row,
 * and a concurrent supersede or citation that waits on a row the job holds finds it gone or
 * already stepped once the job commits (fix rounds 1 and 2, S2): a deadlock with the analysis
 * commit (`touchMemoryEntries`) or the learner, whose victim could have been a finished review,
 * cannot involve a wait of this job.
 *
 * The windows come from `app.retention_settings` (migrator-owned, read-only for the application,
 * with CHECK floors that `checkWindows` repeats here for every caller) and `as_of` is clamped to
 * the database clock once, so a caller can only move the cutoffs into the past (the 0005
 * contract). Each rule takes at most `MAX_MEMORY_DECAY_BATCH` candidates per org per run (for
 * retirement, the chain heads: the learned history behind them goes with them); the next run
 * continues. Results are counts; nothing here reads, returns or logs entry text.
 */

/** Confidence points a learned entry loses per idle period. */
export const MEMORY_DECAY_STEP = 10;
/** Most candidates one rule takes per org per run (keeps the tenant transaction short). */
export const MAX_MEMORY_DECAY_BATCH = 10_000;
/** The system actor the audit rows name. */
export const MEMORY_DECAY_ACTOR = "memory_decay";

export type MemoryDecayWindows = Pick<
  RetentionConfig,
  "memoryDecayDays" | "memoryUnusedDays" | "memorySupersededDays"
>;

/**
 * The floors of migration 0019's CHECKs, held here too so `decayOrgMemory` cannot be handed a
 * window the settings table would refuse (a one-day unused window would erase every repository's
 * learned memory).
 */
export const MEMORY_DECAY_MIN_DAYS: Readonly<Record<keyof MemoryDecayWindows, number>> = {
  memoryDecayDays: 1,
  memoryUnusedDays: MEMORY_UNUSED_MIN_RETENTION_DAYS,
  memorySupersededDays: MEMORY_SUPERSEDED_MIN_RETENTION_DAYS,
};

export interface MemoryDecayOrgReport {
  /** Current learned entries whose confidence dropped one step. */
  readonly decayed: number;
  /** Learned entries deleted for not being cited (chain heads and their learned history). */
  readonly retired: number;
  /** Superseded learned entries deleted past the history window. */
  readonly purged: number;
}

const DAY_MS = 86_400_000;

/**
 * Boundary rule, as retention's: an entry is idle when its idle instant is strictly older than
 * `as_of - days`; one that is exactly `days` old is kept.
 */
export const memoryDecayCutoff = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * DAY_MS);

const checkWindows = (windows: MemoryDecayWindows): void => {
  for (const key of ["memoryDecayDays", "memoryUnusedDays", "memorySupersededDays"] as const) {
    const value = windows[key];
    const min = MEMORY_DECAY_MIN_DAYS[key];
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`memory decay: ${key} must be an integer of at least ${min} (days)`);
    }
  }
};

const checkAsOf = (asOf: Date): void => {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new Error("memory decay: asOf must be a valid Date");
  }
};

/**
 * Superseded learned entries past the history window that nothing points at any more. Tail
 * first: an entry still referenced by an older one waits until that one is gone, so the
 * `ON DELETE SET NULL` of the self-reference never fires and no entry becomes current again.
 * `$2` is the clamped instant.
 */
const LOCK_HISTORY_SQL = `
  select e.id from memory_entries e
   where e.org_id = $1 and e.origin = 'learned' and e.superseded_by is not null
     and e.updated_at < $2::timestamptz - make_interval(days => $3)
     and not exists (select 1 from memory_entries x
                      where x.org_id = $1 and x.superseded_by = e.id)
   order by e.updated_at, e.id
   limit $4
   for update skip locked`;
const PURGE_HISTORY_SQL = `
  delete from memory_entries e
   where e.org_id = $1 and e.id = any($2::uuid[]) and e.superseded_by is not null
     and not exists (select 1 from memory_entries x
                      where x.org_id = $1 and x.superseded_by = e.id)`;

/**
 * Current learned entries past the unused window (locked first), then the chain behind each
 * (every entry that leads to it through `superseded_by`). Each entry points at one successor, so
 * the entries that lead to a current head form a tree and the walk ends; a loop a crafted update
 * could plant (ADR 0036 nit 6) has no path to a head and is never reached. `union` (not `union
 * all`) is belt and braces: a repeated (id, head) pair ends the recursion anyway. A chain with a
 * member-written entry anywhere is kept whole: the job never deletes what a person wrote. The
 * chain is computed after the heads are locked, so a supersede that made a locked head the
 * successor of a member-written entry is either visible here (the chain is then skipped) or
 * waiting on the lock (and then finds the head gone). The chain's rows are then locked `SKIP
 * LOCKED` too, and a chain with a row held elsewhere waits for the next run.
 */
const LOCK_HEADS_SQL = `
  select e.id from memory_entries e
   where e.org_id = $1 and e.origin = 'learned' and e.superseded_by is null
     and greatest(e.created_at, coalesce(e.last_used_at, e.created_at))
           < $2::timestamptz - make_interval(days => $3)
   order by e.created_at, e.id
   limit $4
   for update skip locked`;
const CHAIN_SQL = `
  with recursive chain as (
    select h.id, h.id as head from unnest($2::uuid[]) as h(id)
    union
    select e.id, c.head from memory_entries e
      join chain c on e.org_id = $1 and e.superseded_by = c.id
  )
  select c.id, c.head, e.origin = 'learned' as learned
    from chain c join memory_entries e on e.org_id = $1 and e.id = c.id`;
const LOCK_ROWS_SQL = `
  select e.id from memory_entries e
   where e.org_id = $1 and e.id = any($2::uuid[])
   order by e.id
   for update skip locked`;
const DELETE_ROWS_SQL = `delete from memory_entries e where e.org_id = $1 and e.id = any($2::uuid[])`;

/**
 * Current learned entries idle for a decay period since their last citation, creation or decay
 * step, whichever is latest (locked first, so a citation that committed meanwhile keeps the
 * entry out, and one still in flight leaves it for the next run). `decayed_at` is set to the
 * clamped instant, so the same instant never decays twice and a later citation restarts the
 * clock.
 */
const LOCK_DECAY_SQL = `
  select e.id from memory_entries e
   where e.org_id = $1 and e.origin = 'learned' and e.superseded_by is null
     and e.confidence > 0
     and greatest(e.created_at, coalesce(e.last_used_at, e.created_at),
                  coalesce(e.decayed_at, e.created_at))
           < $2::timestamptz - make_interval(days => $3)
   order by e.created_at, e.id
   limit $4
   for update skip locked`;
const DECAY_SQL = `
  update memory_entries e
     set confidence = greatest(0, e.confidence - $4), decayed_at = $3::timestamptz
   where e.org_id = $1 and e.id = any($2::uuid[])`;

const ids = (rows: { id: string }[]): string[] => rows.map((row) => row.id);

/**
 * For tests that pin the statement order S2 relies on (the heads are locked before the chain
 * behind them is walked): the exact text of the heads lock, so a test can act between the two.
 */
export const MEMORY_DECAY_STATEMENTS = { lockHeads: LOCK_HEADS_SQL } as const;

/**
 * The chains behind the locked heads: every row of a chain that is all learned and whose other
 * rows could all be locked without waiting. Returns the ids to delete.
 */
const retirableChains = async (tx: TenantTx, heads: string[]): Promise<string[]> => {
  const chain = await tx.query<{ id: string; head: string; learned: boolean }>(CHAIN_SQL, [
    tx.orgId,
    heads,
  ]);
  const skipped = new Set<string>();
  for (const row of chain.rows) if (!row.learned) skipped.add(row.head);
  const behind = chain.rows.filter((row) => row.id !== row.head && !skipped.has(row.head));
  if (behind.length > 0) {
    const locked = new Set(
      ids((await tx.query<{ id: string }>(LOCK_ROWS_SQL, [tx.orgId, ids(behind)])).rows),
    );
    for (const row of behind) if (!locked.has(row.id)) skipped.add(row.head);
  }
  return ids(chain.rows.filter((row) => !skipped.has(row.head)));
};

/**
 * Applies the three rules to the current org as of `asOf` (clamped to the database clock) and,
 * when anything changed, writes one `memory.decayed` audit event with the counts and the clamped
 * instant. Idempotent at any instant.
 */
export const decayOrgMemory = async (
  tx: TenantTx,
  input: { readonly asOf: Date; readonly windows: MemoryDecayWindows },
): Promise<MemoryDecayOrgReport> => {
  checkAsOf(input.asOf);
  checkWindows(input.windows);
  const { windows } = input;
  // Clamped once: every rule and the audit row use the same instant, never one past the clock.
  const clamped = await tx.query<{ t: Date }>("select least($1::timestamptz, now()) as t", [
    input.asOf,
  ]);
  const asOf = clamped.rows[0]?.t;
  if (!(asOf instanceof Date)) throw new Error("memory decay: the database clock is unavailable");

  const history = await tx.query<{ id: string }>(LOCK_HISTORY_SQL, [
    tx.orgId,
    asOf,
    windows.memorySupersededDays,
    MAX_MEMORY_DECAY_BATCH,
  ]);
  const purged =
    history.rows.length === 0
      ? 0
      : ((await tx.query(PURGE_HISTORY_SQL, [tx.orgId, ids(history.rows)])).rowCount ?? 0);

  const heads = await tx.query<{ id: string }>(LOCK_HEADS_SQL, [
    tx.orgId,
    asOf,
    windows.memoryUnusedDays,
    MAX_MEMORY_DECAY_BATCH,
  ]);
  const victims = heads.rows.length === 0 ? [] : await retirableChains(tx, ids(heads.rows));
  const retired =
    victims.length === 0
      ? 0
      : ((await tx.query(DELETE_ROWS_SQL, [tx.orgId, victims])).rowCount ?? 0);

  const candidates = await tx.query<{ id: string }>(LOCK_DECAY_SQL, [
    tx.orgId,
    asOf,
    windows.memoryDecayDays,
    MAX_MEMORY_DECAY_BATCH,
  ]);
  const decayed =
    candidates.rows.length === 0
      ? 0
      : ((await tx.query(DECAY_SQL, [tx.orgId, ids(candidates.rows), asOf, MEMORY_DECAY_STEP]))
          .rowCount ?? 0);

  const report: MemoryDecayOrgReport = { decayed, retired, purged };
  if (decayed + retired + purged > 0) {
    await audit(
      tx,
      { type: "system", id: MEMORY_DECAY_ACTOR },
      "memory.decayed",
      { type: "table", id: "memory_entries" },
      { ...report, asOf: asOf.toISOString() },
    );
  }
  return report;
};

export interface MemoryDecayReport {
  readonly ranAt: Date;
  /** Orgs visited (every live org, whether or not anything changed). */
  readonly orgs: number;
  readonly decayed: number;
  readonly retired: number;
  readonly purged: number;
  /** Orgs whose run failed, with the error's SQLSTATE or code only; the others still ran. */
  readonly failures: readonly { readonly orgId: OrgId; readonly errorCode: string }[];
}

const codeOf = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return typeof code === "string" && /^[0-9A-Z]{5}$|^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : "internal_error";
};

/**
 * Runs the decay for every live org, each in its own `withOrg` transaction, as of the injected
 * clock. One org's failure is recorded by code and does not stop the others. Worker login only
 * (the org list is `worker.live_orgs`).
 */
export const runMemoryDecay = async (
  db: Db,
  deps: { readonly clock: Clock },
): Promise<MemoryDecayReport> => {
  const settings = await db.retentionSettings();
  const windows: MemoryDecayWindows = {
    memoryDecayDays: settings.memoryDecayDays,
    memoryUnusedDays: settings.memoryUnusedDays,
    memorySupersededDays: settings.memorySupersededDays,
  };
  checkWindows(windows);
  const ranAt = deps.clock.now();
  checkAsOf(ranAt);
  let orgs = 0;
  let decayed = 0;
  let retired = 0;
  let purged = 0;
  const failures: { orgId: OrgId; errorCode: string }[] = [];
  let after: OrgId | null = null;
  for (;;) {
    const page: OrgId[] = await db.liveOrgs(after, MAX_LIVE_ORGS_PAGE);
    for (const orgId of page) {
      orgs++;
      try {
        const report = await db.withOrg(orgId, (tx) =>
          decayOrgMemory(tx, { asOf: ranAt, windows }),
        );
        decayed += report.decayed;
        retired += report.retired;
        purged += report.purged;
      } catch (error) {
        failures.push({ orgId, errorCode: codeOf(error) });
      }
    }
    const last = page.at(-1);
    if (last === undefined || page.length < MAX_LIVE_ORGS_PAGE) break;
    after = last;
  }
  return { ranAt, orgs, decayed, retired, purged, failures };
};
