-- Hand written (spec 0009, milestone 2): what Drizzle cannot express for the two license tables of
-- 0003_license_tables.sql. Both are append only (spec 0002, tenancy child, A4): the application
-- role inserts and reads them, never changes them, and the `ssd_reject_change` triggers refuse an
-- UPDATE, DELETE, or TRUNCATE for every role, the owner included. Edited by hand, never generated.

-- Stamps owned by the database (security review M2-2, M2-6), each fired in name order before any
-- other insert trigger of its table:
--   licenses_0_stamp_recorded_at: `statement` clock, so a license recorded after another committed
--     one is never dated before it.
--   <table>_1_stamp_id: `id := uuidv7()`, so a writer never chooses an id (as `audit_entries` does).
--   license_checks_2_stamp_seq: `seq` from its own sequence, whatever a writer sent (also with
--     OVERRIDING SYSTEM VALUE), so the latest check is the last inserted one, never a planted row.
-- `license_checks` has no `recorded_at`: its `checked_at` comes from the platform clock the license
-- service reads after the check lock.
CREATE FUNCTION "ssd_stamp_id"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.id := pg_catalog.uuidv7();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "license_checks_stamp_seq"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.seq := pg_catalog.nextval('public.license_checks_seq_seq'::pg_catalog.regclass);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "licenses_0_stamp_recorded_at" BEFORE INSERT ON "licenses" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('statement');--> statement-breakpoint
CREATE TRIGGER "licenses_1_stamp_id" BEFORE INSERT ON "licenses" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_id"();--> statement-breakpoint
CREATE TRIGGER "license_checks_1_stamp_id" BEFORE INSERT ON "license_checks" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_id"();--> statement-breakpoint
CREATE TRIGGER "license_checks_2_stamp_seq" BEFORE INSERT ON "license_checks" FOR EACH ROW EXECUTE FUNCTION "license_checks_stamp_seq"();--> statement-breakpoint
CREATE TRIGGER "licenses_append_only" BEFORE UPDATE OR DELETE ON "licenses" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "licenses_no_truncate" BEFORE TRUNCATE ON "licenses" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "license_checks_append_only" BEFORE UPDATE OR DELETE ON "license_checks" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "license_checks_no_truncate" BEFORE TRUNCATE ON "license_checks" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint

-- The default privileges of 0002 gave the application role every right on the new tables (and
-- USAGE on the `seq` sequence, which the stamp needs); take back what append only history must
-- never allow.
DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app');
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "licenses", "license_checks" FROM %I', app_role);
END;
$$;
