-- Reverts 0014. Owners become admins (the role 0002 knew closest to it); pending and finished
-- `org_member.removed` inbox rows are dropped (0006's CHECK does not accept them), and so are
-- their `org_member` lane rows in the ready queue (0007), which a delete does not clean up (only
-- the claim does, and no claim asks for that lane any more). FORCE RLS hides every row from the
-- owner, so it is lifted for those statements only (0012's pattern).

ALTER TABLE app.webhook_deliveries NO FORCE ROW LEVEL SECURITY;
DELETE FROM app.webhook_deliveries WHERE event_type LIKE 'org_member.%';
ALTER TABLE app.webhook_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_queue NO FORCE ROW LEVEL SECURITY;
DELETE FROM app.webhook_queue WHERE lane = 'org_member';
ALTER TABLE app.webhook_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE app.webhook_deliveries DROP CONSTRAINT webhook_deliveries_org_member_shape;
ALTER TABLE app.webhook_deliveries DROP CONSTRAINT webhook_deliveries_event_type_check;
ALTER TABLE app.webhook_deliveries ADD CONSTRAINT webhook_deliveries_event_type_check
  CHECK (event_type IN (
    'installation.created', 'installation.deleted',
    'pull_request.opened', 'pull_request.synchronize',
    'pull_request.closed', 'pull_request.reopened'));

REVOKE DELETE ON app.session_orgs FROM rocky_app;
DROP POLICY session_orgs_app_delete ON app.session_orgs;

DROP TRIGGER members_keep_an_owner ON members;
DROP FUNCTION app.members_keep_an_owner();
DROP FUNCTION app.lock_org_owners(uuid);

ALTER TABLE members DROP CONSTRAINT members_role_check;
ALTER TABLE members NO FORCE ROW LEVEL SECURITY;
UPDATE members SET role = 'admin' WHERE role = 'owner';
ALTER TABLE members FORCE ROW LEVEL SECURITY;
ALTER TABLE members ADD CONSTRAINT members_role_check CHECK (role IN ('admin', 'member'));
