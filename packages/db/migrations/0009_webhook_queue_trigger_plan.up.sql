-- 0009 webhook queue update trigger: no nested loop over transition tables (P3-3 follow-up).
--
-- worker.webhook_queue_on_update() (0007) joins the statement's OLD and NEW transition tables on
-- (forge, delivery_id). Transition tables carry no statistics or indexes, and the planner can pick
-- a nested loop: quadratic in the rows one statement changes. A 20k-row UPDATE took ~49 s in CI
-- instead of well under a second, and the same path runs for every bulk change of inbox rows
-- (delete_org scrubbing an installation's rows, a worker completion collapsing superseded rows).
-- Turning nested loops off for this one function makes the join a hash join: linear, with no
-- change to what the trigger computes. The function keeps its owner (rocky_lifecycle), so the
-- owner applies the setting.
-- The owner needs USAGE on the schema to name the function; granted for this statement only
-- (the 0007 pattern for rocky_retention).
GRANT USAGE ON SCHEMA worker TO rocky_lifecycle;
SET LOCAL ROLE rocky_lifecycle;
ALTER FUNCTION worker.webhook_queue_on_update() SET enable_nestloop = off;
RESET ROLE;
REVOKE USAGE ON SCHEMA worker FROM rocky_lifecycle;
