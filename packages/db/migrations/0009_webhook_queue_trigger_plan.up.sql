-- 0009 webhook queue update trigger: no nested loop over transition tables (P3-3 follow-up).
--
-- worker.webhook_queue_on_update() (0007) joins the statement's OLD and NEW transition tables on
-- (forge, delivery_id). plpgsql plans that statement once per connection and reuses the plan.
-- The first firing on a connection is usually a 1-row update (the worker's claim, complete or
-- fail), for which a nested loop is the cheapest plan; every later bulk update on that
-- connection then reuses it, quadratic in the rows changed. A 20k-row UPDATE took ~49 s in CI
-- instead of well under a second. Bulk paths take it: delete_org scrubbing an installation's
-- rows, a worker completion collapsing superseded rows. Rewriting the join would not help (it
-- is cached the same way, and plan_cache_mode does not apply to a statement without
-- parameters). Turning nested loops off for this one function leaves hash or merge join, which
-- are fine at one row and linear at many; what the trigger computes is unchanged, and the
-- setting is restored when the function returns. The function keeps its owner
-- (rocky_lifecycle), so the owner applies the setting.
-- The owner needs USAGE on the schema to name the function; granted for this statement only
-- (the 0007 pattern for rocky_retention).
GRANT USAGE ON SCHEMA worker TO rocky_lifecycle;
SET LOCAL ROLE rocky_lifecycle;
ALTER FUNCTION worker.webhook_queue_on_update() SET enable_nestloop = off;
RESET ROLE;
REVOKE USAGE ON SCHEMA worker FROM rocky_lifecycle;
