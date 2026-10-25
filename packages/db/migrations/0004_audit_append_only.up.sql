-- 0004 audit_events is append-only (P2-5).
--
-- The trigger fires for every role, including the table owner, so a privileged ad-hoc session
-- cannot silently rewrite history. The single exception is DELETE as rocky_retention: that role
-- cannot log in and only exists as the owner of the retention purge functions (0005), which
-- delete rows older than a bounded cutoff. Everything else raises insufficient_privilege.
CREATE FUNCTION app.audit_events_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'rocky_retention' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only: % blocked for role %', TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit rows are removed only by the retention purge (retention.purge_audit_events).';
END
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION app.audit_events_append_only();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION app.audit_events_append_only();
