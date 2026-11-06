import type { Clock, OrgId } from "@rocky-reviews/core";
import { audit } from "./audit.js";
import { MAX_LIVE_ORGS_PAGE, type Db, type TenantTx } from "./client.js";
import type { RetentionConfig } from "./retention-sql.js";

/**
 * Project memory decay (P8-4, migration 0019, ADR 0038). A scheduled job that, per org and inside
 * that org's `withOrg` transaction (RLS on `memory_entries` and `embeddings`; the explicit
 * `org_id` filters are defence in depth), applies three time-based rules to **learned** entries:
 *
 * 1. **Decay:** a current learned entry that no review has cited for `memoryDecayDays` (since its
 *    last citation, its creation or its last decay step) loses `MEMORY_DECAY_STEP` confidence
 *    points, down to 0, and records the step in `decayed_at`, so a run takes at most one step per
 *    idle period.
 * 2. **Retire:** a current learned entry that no review has cited for `memoryUnusedDays` is
 *    deleted together with the learned entries it superseded (the chain behind it), because
 *    `superseded_by … ON DELETE SET NULL` would otherwise make the older entry current again. A
 *    chain that holds a member-written entry anywhere is left alone.
 * 3. **History:** a superseded learned entry is deleted `memorySupersededDays` after it was
 *    superseded (`updated_at`, stamped by the supersede), tail first: never while another entry
 *    still points at it.
 *
 * Member-written entries are never decayed, retired or purged, current or as history: a person
 * wrote them and P8-3 is where people edit and delete them. Deletion is permanent; the entries
 * are derived data (GitHub holds the reviews they came from).
 *
 * The windows come from `app.retention_settings` (migrator-owned, read-only for the application,
 * with CHECK floors) and `as_of` is clamped to the database clock, so a caller can only move the
 * cutoffs into the past (the 0005 contract). Each statement is bounded to `MAX_MEMORY_DECAY_BATCH`
 * rows per org per run; the next run continues. Results are counts; nothing here reads, returns
 * or logs entry text.
 */

/** Confidence points a learned entry loses per idle period. */
export const MEMORY_DECAY_STEP = 10;
/** Most rows one rule touches per org per run (keeps the tenant transaction short). */
export const MAX_MEMORY_DECAY_BATCH = 10_000;
/** The system actor the audit rows name. */
export const MEMORY_DECAY_ACTOR = "memory_decay";

export type MemoryDecayWindows = Pick<
  RetentionConfig,
  "memoryDecayDays" | "memoryUnusedDays" | "memorySupersededDays"
>;

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
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`memory decay: ${key} must be an integer of at least 1 (days)`);
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
 */
const PURGE_HISTORY_SQL = `
  with as_of as (select least($2::timestamptz, now()) as t),
  victims as (
    select e.id from memory_entries e, as_of
     where e.org_id = $1 and e.origin = 'learned' and e.superseded_by is not null
       and e.updated_at < as_of.t - make_interval(days => $3)
       and not exists (select 1 from memory_entries x
                        where x.org_id = $1 and x.superseded_by = e.id)
     order by e.updated_at, e.id
     limit $4
  )
  delete from memory_entries e using victims v where e.org_id = $1 and e.id = v.id`;

/**
 * Current learned entries past the unused window, with the chain behind each (every entry that
 * leads to it through `superseded_by`). Each entry points at one successor, so the entries that
 * lead to a current head form a tree and the walk ends; a loop a crafted update could plant
 * (ADR 0036 nit 6) has no path to a head and is never reached. `union` (not `union all`) is
 * belt and braces: a repeated (id, head) pair ends the recursion anyway. A chain with a
 * member-written entry anywhere is kept whole: the job never deletes what a person wrote.
 */
const RETIRE_SQL = `
  with recursive as_of as (select least($2::timestamptz, now()) as t),
  heads as (
    select e.id from memory_entries e, as_of
     where e.org_id = $1 and e.origin = 'learned' and e.superseded_by is null
       and greatest(e.created_at, coalesce(e.last_used_at, e.created_at))
             < as_of.t - make_interval(days => $3)
     order by e.created_at, e.id
     limit $4
  ),
  chain as (
    select h.id, h.id as head from heads h
    union
    select e.id, c.head from memory_entries e
      join chain c on e.org_id = $1 and e.superseded_by = c.id
  ),
  mixed as (
    select distinct c.head from chain c
      join memory_entries e on e.org_id = $1 and e.id = c.id
     where e.origin <> 'learned'
  )
  delete from memory_entries e using chain c
   where e.org_id = $1 and e.id = c.id
     and not exists (select 1 from mixed m where m.head = c.head)`;

/**
 * Current learned entries idle for a decay period since their last citation, creation or decay
 * step, whichever is latest. `decayed_at` is set to the clamped `as_of`, so the same instant
 * never decays twice and a later citation restarts the clock.
 */
const DECAY_SQL = `
  with as_of as (select least($2::timestamptz, now()) as t),
  candidates as (
    select e.id from memory_entries e, as_of
     where e.org_id = $1 and e.origin = 'learned' and e.superseded_by is null
       and e.confidence > 0
       and greatest(e.created_at, coalesce(e.last_used_at, e.created_at),
                    coalesce(e.decayed_at, e.created_at))
             < as_of.t - make_interval(days => $3)
     order by e.created_at, e.id
     limit $4
  )
  update memory_entries e
     set confidence = greatest(0, e.confidence - $5), decayed_at = as_of.t
    from candidates c, as_of
   where e.org_id = $1 and e.id = c.id`;

/**
 * Applies the three rules to the current org as of `asOf` (clamped to the database clock) and,
 * when anything changed, writes one `memory.decayed` audit event with the counts. Idempotent at
 * any instant.
 */
export const decayOrgMemory = async (
  tx: TenantTx,
  input: { readonly asOf: Date; readonly windows: MemoryDecayWindows },
): Promise<MemoryDecayOrgReport> => {
  checkAsOf(input.asOf);
  checkWindows(input.windows);
  const { asOf, windows } = input;
  const purged = await tx.query(PURGE_HISTORY_SQL, [
    tx.orgId,
    asOf,
    windows.memorySupersededDays,
    MAX_MEMORY_DECAY_BATCH,
  ]);
  const retired = await tx.query(RETIRE_SQL, [
    tx.orgId,
    asOf,
    windows.memoryUnusedDays,
    MAX_MEMORY_DECAY_BATCH,
  ]);
  const decayed = await tx.query(DECAY_SQL, [
    tx.orgId,
    asOf,
    windows.memoryDecayDays,
    MAX_MEMORY_DECAY_BATCH,
    MEMORY_DECAY_STEP,
  ]);
  const report: MemoryDecayOrgReport = {
    decayed: decayed.rowCount ?? 0,
    retired: retired.rowCount ?? 0,
    purged: purged.rowCount ?? 0,
  };
  if (report.decayed + report.retired + report.purged > 0) {
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
