-- Hand written (spec 0002, A1 to A4, A13): what Drizzle cannot express. Functions, triggers, the
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
CREATE FUNCTION "ssd_reject_change"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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

-- Cost records are write once (spec 0002, A4): a correction is a newer record.
CREATE TRIGGER "cost_records_append_only" BEFORE UPDATE OR DELETE ON "cost_records" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "cost_records_no_truncate" BEFORE TRUNCATE ON "cost_records" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint

-- The operating day (spec 0002, A3): the brand's local calendar day of an instant, with an
-- optional cutoff hour (an order at 01:30 with cutoff 2 belongs to the previous day). It reads the
-- settings `timezone` and `operating_day_cutoff_hour`, so it is STABLE, not IMMUTABLE, and cannot
-- back a generated column; a trigger stores the day instead. Stored days are never restated.
CREATE FUNCTION "ssd_operating_day"(at timestamptz) RETURNS date STABLE LANGUAGE sql AS $$
  SELECT ((at AT TIME ZONE coalesce(
            (SELECT value #>> '{}' FROM public.settings
              WHERE tenant_id = current_setting('ssd.tenant_id')::uuid AND key = 'timezone'),
            'Africa/Cairo'))
          - make_interval(hours => coalesce(
            (SELECT (value #>> '{}')::int FROM public.settings
              WHERE tenant_id = current_setting('ssd.tenant_id')::uuid AND key = 'operating_day_cutoff_hour'),
            0)))::date
$$;--> statement-breakpoint
-- The source column name is the trigger argument: BEFORE INSERT OR UPDATE OF <source>.
CREATE FUNCTION "ssd_stamp_operating_day"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  source_at timestamptz;
BEGIN
  EXECUTE format('SELECT ($1).%I', TG_ARGV[0]) INTO source_at USING NEW;
  NEW.operating_day := public.ssd_operating_day(source_at);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "movement_groups_stamp_operating_day" BEFORE INSERT OR UPDATE OF "effective_at" ON "movement_groups" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_operating_day"('effective_at');--> statement-breakpoint
CREATE TRIGGER "stock_movements_stamp_operating_day" BEFORE INSERT OR UPDATE OF "effective_at" ON "stock_movements" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_operating_day"('effective_at');--> statement-breakpoint

-- A location's owner type and party are fixed for its life (spec 0002, A13). A showroom that
-- closes, or a partner that becomes a wholesale customer, gets a new location.
CREATE FUNCTION "locations_reject_owner_change"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'OwnerTypeFixed: the owner type and party of location % cannot change', OLD.code
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'locations_owner_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "locations_owner_fixed" BEFORE UPDATE ON "locations" FOR EACH ROW WHEN (OLD."owner_type" IS DISTINCT FROM NEW."owner_type" OR OLD."party_id" IS DISTINCT FROM NEW."party_id") EXECUTE FUNCTION "locations_reject_owner_change"();--> statement-breakpoint

-- A reversal group can never itself be reversed.
CREATE FUNCTION "movement_groups_reject_reversal_of_reversal"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.reverses_group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.movement_groups WHERE id = NEW.reverses_group_id AND reverses_group_id IS NOT NULL
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
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "movement_groups", "stock_movements", "movement_serials", "stock_receipt_lines", "cost_records" FROM %I', app_role);
  -- Receipts are never deleted; the app role keeps UPDATE for the void columns (spec 0006).
  EXECUTE format('REVOKE DELETE, TRUNCATE ON "stock_receipts" FROM %I', app_role);
  -- The owner type policy is read only for the app role until feature 9 grants editing back.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "location_owner_policies" FROM %I', app_role);
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
  ('default_language', '"en"'),
  -- Hour (0 to 23) before which an instant still belongs to the previous operating day (A3).
  ('operating_day_cutoff_hour', '0')
ON CONFLICT ("tenant_id", "key") DO NOTHING;--> statement-breakpoint
INSERT INTO "uoms" ("code", "name") VALUES ('pc', '{"en": "Piece", "ar": "قطعة"}');--> statement-breakpoint
INSERT INTO "product_groups" ("code", "name") VALUES ('MAIN', '{"en": "Main", "ar": "الرئيسية"}');--> statement-breakpoint
INSERT INTO "seasons" ("code", "name") VALUES ('CORE', '{"en": "Core", "ar": "أساسي"}');--> statement-breakpoint
INSERT INTO "locations" ("code", "name", "kind", "owner_type", "is_sellable") VALUES
  ('TRANSIT', '{"en": "In transit", "ar": "قيد النقل"}', 'transit', 'own', false),
  ('SCRAP', '{"en": "Scrap", "ar": "تالف"}', 'virtual', 'own', false);--> statement-breakpoint
-- The owner type policy (final plan 6.5); read only through LocationPolicyService.
INSERT INTO "location_owner_policies" ("owner_type", "stock_owned_by_brand", "handover_is_sale", "sale_recorded_at", "end_customer_refund_by", "defective_piece_refund_by", "tax_document", "settlement_owner_type", "can_sell_online") VALUES
  ('own', true, false, 'at_shipment', 'brand', 'brand', 'b2c_electronic_receipt', NULL, true),
  ('consignment_partner', true, false, 'at_sell_through', 'location_owner', 'brand', 'b2b_electronic_invoice_at_settlement', 'consignment_partner', false),
  ('wholesale_customer', false, true, 'at_handover', 'location_owner', 'location_owner', 'b2b_electronic_invoice_at_handover', NULL, false);
