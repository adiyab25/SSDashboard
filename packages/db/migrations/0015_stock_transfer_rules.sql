-- Hand written (spec 0011, milestone 1): what Drizzle cannot express for the stock transfer table
-- of 0014_online_location_and_transfer_tables.sql. Edited by hand, never generated.

-- Showroom moves are write once (spec 0011 AC-25), like the receipt lines: the application role
-- cannot UPDATE, DELETE, or TRUNCATE them, and the trigger is the second guard for every role.
CREATE TRIGGER "stock_transfers_append_only" BEFORE UPDATE OR DELETE ON "stock_transfers" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "stock_transfers_no_truncate" BEFORE TRUNCATE ON "stock_transfers" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint

-- The database stamps the instant, one per posting, like the stock ledger it sits beside.
CREATE TRIGGER "stock_transfers_0_stamp_recorded_at" BEFORE INSERT ON "stock_transfers" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('transaction');--> statement-breakpoint

DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app');
BEGIN
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "stock_transfers" FROM %I', app_role);
END;
$$;--> statement-breakpoint

-- Numbering of the showroom move: `TR-YYYY-NNNNNN`. Merged into the stored prefixes, the other
-- keys kept; a prefix someone already set for it wins.
UPDATE "settings"
SET "value" = '{"stock_transfer": "TR"}'::jsonb || "value"
WHERE "key" = 'document_prefixes';
