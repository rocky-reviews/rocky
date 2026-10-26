DROP TRIGGER IF EXISTS audit_events_stamp ON audit_events;
DROP FUNCTION IF EXISTS app.audit_events_stamp();
DROP TRIGGER IF EXISTS audit_events_no_truncate ON audit_events;
DROP TRIGGER IF EXISTS audit_events_no_update_delete ON audit_events;
DROP FUNCTION IF EXISTS app.audit_events_append_only();
