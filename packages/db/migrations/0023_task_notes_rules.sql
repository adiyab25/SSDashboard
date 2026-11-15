-- Hand written (spec 0016, milestone 1): what Drizzle cannot express for the `task_notes` table of
-- 0022_tasks_delta.sql. Edited by hand, never generated.

-- A note is write once (spec 0016 AC-11): the application role cannot UPDATE, DELETE, or TRUNCATE
-- it, and the trigger is the second guard for every role.
CREATE TRIGGER "task_notes_append_only" BEFORE UPDATE OR DELETE ON "task_notes" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "task_notes_no_truncate" BEFORE TRUNCATE ON "task_notes" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app');
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "task_notes" FROM %I', app_role);
END;
$$;
