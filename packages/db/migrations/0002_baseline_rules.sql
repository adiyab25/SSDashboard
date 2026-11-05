-- Hand written (spec 0002, A1, A2, A4): what Drizzle cannot express. Functions, triggers, the
-- application role, grants, revokes, the pg-boss schema, and the seeds. Edited by hand, never
-- generated; the tables file (0001) is the only one drizzle-kit regenerates.
--
-- Every statement that names the application role goes through a DO block that reads the
-- `ssd.app_role` database setting (set by `migrate` before the first migration), falling back to
-- `ssdashboard_app`. Seeds rely on the `ssd.tenant_id` setting through the tenant_id column default.

-- The application role. The api and worker connect as it; the owner role only migrates.
-- Its login and password are set by the migrate entry point from APP_DB_PASSWORD.
DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', app_role);
  END IF;
END;
$$;--> statement-breakpoint

-- pg-boss (the `worker` entry point) keeps its job tables in their own schema. The application
-- role owns it, so pg-boss can install and upgrade itself there, and the application role still
-- needs no CREATE right on the database.
DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app');
BEGIN
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION %I', app_role);
END;
$$;--> statement-breakpoint

-- The ledger history is append only (AC-2, AC-33). The application role cannot UPDATE, DELETE,
-- or TRUNCATE these tables (revokes below); this trigger function is the second guard, for every
-- role, the owner included.
CREATE FUNCTION "ssd_reject_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append only: % is not allowed. Correct it with a reversal posting.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "movement_groups_append_only" BEFORE UPDATE OR DELETE ON "movement_groups" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "movement_groups_no_truncate" BEFORE TRUNCATE ON "movement_groups" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "stock_movements_append_only" BEFORE UPDATE OR DELETE ON "stock_movements" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "stock_movements_no_truncate" BEFORE TRUNCATE ON "stock_movements" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "movement_serials_append_only" BEFORE UPDATE OR DELETE ON "movement_serials" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "movement_serials_no_truncate" BEFORE TRUNCATE ON "movement_serials" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
-- Receipt lines are write once (spec 0006, A4): the same two guards.
CREATE TRIGGER "stock_receipt_lines_append_only" BEFORE UPDATE OR DELETE ON "stock_receipt_lines" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "stock_receipt_lines_no_truncate" BEFORE TRUNCATE ON "stock_receipt_lines" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint

-- A reversal group can never itself be reversed.
CREATE FUNCTION "movement_groups_reject_reversal_of_reversal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reverses_group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM movement_groups WHERE id = NEW.reverses_group_id AND reverses_group_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'movement group % is a reversal and cannot be reversed', NEW.reverses_group_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "movement_groups_no_reversal_of_reversal" BEFORE INSERT ON "movement_groups" FOR EACH ROW EXECUTE FUNCTION "movement_groups_reject_reversal_of_reversal"();--> statement-breakpoint

-- At most one open discrepancy per balance and kind (AC-11). Drizzle cannot express a partial
-- unique index with NULLS NOT DISTINCT. It leads with tenant_id because `kind` is not a uuid.
CREATE UNIQUE INDEX "stock_level_discrepancies_open_unique" ON "stock_level_discrepancies" ("tenant_id","kind","variant_id","location_id","bin_id","lot_id") NULLS NOT DISTINCT WHERE "resolved_at" IS NULL;--> statement-breakpoint

-- The install row names the tenant. Exactly one row, and its id must equal the database setting.
CREATE UNIQUE INDEX "install_single_row_unique" ON "install" ((true));--> statement-breakpoint
ALTER TABLE "install" ADD CONSTRAINT "install_id_is_tenant_id" CHECK ("id" = current_setting('ssd.tenant_id')::uuid);--> statement-breakpoint

-- Grants for the application role. Tables later migrations create are readable and writable by
-- default; an append only table revokes like the ones below.
DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app');
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', app_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', app_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', app_role);
  -- Append only history (A4): the app role inserts and reads, never changes.
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "movement_groups", "stock_movements", "movement_serials", "stock_receipt_lines" FROM %I', app_role);
  -- Receipts are never deleted; the app role keeps UPDATE for the void columns (spec 0006).
  EXECUTE format('REVOKE DELETE, TRUNCATE ON "stock_receipts" FROM %I', app_role);
  -- Only migrate writes the install row.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "install" FROM %I', app_role);
END;
$$;--> statement-breakpoint

-- Seeds. The tenant_id column default stamps each row with this install's tenant.
INSERT INTO "settings" ("key", "value") VALUES
  ('currency', '"EGP"'),
  ('timezone', '"Africa/Cairo"'),
  ('prices_include_vat', 'true'),
  ('inventory_lock_date', 'null'),
  ('document_prefixes', '{"PO": "PO", "GRN": "GRN", "SO": "SO", "SHP": "SHP", "RMA": "RMA", "TRF": "TRF", "ADJ": "ADJ", "CNT": "CNT", "MO": "MO", "stock_receipt": "SR"}'),
  -- Which languages the back office offers, in switcher order, and which one a first visit opens in (spec 0004).
  ('languages', '["en", "ar"]'),
  ('default_language', '"en"')
ON CONFLICT ("tenant_id", "key") DO NOTHING;--> statement-breakpoint
INSERT INTO "uoms" ("code", "name") VALUES ('pc', '{"en": "Piece", "ar": "قطعة"}');--> statement-breakpoint
INSERT INTO "locations" ("code", "name", "type", "is_sellable") VALUES
  ('TRANSIT', '{"en": "In transit", "ar": "قيد النقل"}', 'transit', false),
  ('SCRAP', '{"en": "Scrap", "ar": "تالف"}', 'virtual', false);
