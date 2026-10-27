GRANT USAGE ON SCHEMA worker TO rocky_lifecycle;
SET LOCAL ROLE rocky_lifecycle;
ALTER FUNCTION worker.webhook_queue_on_update() RESET enable_nestloop;
RESET ROLE;
REVOKE USAGE ON SCHEMA worker FROM rocky_lifecycle;
