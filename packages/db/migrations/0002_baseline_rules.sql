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

-- The history tables are append only (AC-2, AC-33). The application role cannot UPDATE, DELETE,
-- or TRUNCATE them (revokes below); this trigger function is the second guard, for every role,
-- the owner included. A correction is always a new row (a reversal, a later event, an undo).
CREATE FUNCTION "ssd_reject_change"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append only: % is not allowed. Correct it with a new row.', TG_TABLE_NAME, TG_OP
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

-- Order events are write once (spec 0002, A4): a correction is a later event.
CREATE TRIGGER "order_events_append_only" BEFORE UPDATE OR DELETE ON "order_events" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "order_events_no_truncate" BEFORE TRUNCATE ON "order_events" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
-- Customer merges are write once (spec 0002, A4): a merge is corrected by an undo row.
CREATE TRIGGER "customer_merges_append_only" BEFORE UPDATE OR DELETE ON "customer_merges" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "customer_merges_no_truncate" BEFORE TRUNCATE ON "customer_merges" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
-- Credit entries are write once (spec 0002, A4): a correction is a reversal entry.
CREATE TRIGGER "credit_entries_append_only" BEFORE UPDATE OR DELETE ON "credit_entries" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "credit_entries_no_truncate" BEFORE TRUNCATE ON "credit_entries" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
-- Settlement statements, lines, match rows, and period events are write once (spec 0002, A4): a
-- statement is corrected by a superseding statement, a line by an adjustment line, a match or an
-- event by a later row.
CREATE TRIGGER "settlement_statements_append_only" BEFORE UPDATE OR DELETE ON "settlement_statements" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "settlement_statements_no_truncate" BEFORE TRUNCATE ON "settlement_statements" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "settlement_lines_append_only" BEFORE UPDATE OR DELETE ON "settlement_lines" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "settlement_lines_no_truncate" BEFORE TRUNCATE ON "settlement_lines" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "settlement_line_matches_append_only" BEFORE UPDATE OR DELETE ON "settlement_line_matches" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "settlement_line_matches_no_truncate" BEFORE TRUNCATE ON "settlement_line_matches" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "settlement_period_events_append_only" BEFORE UPDATE OR DELETE ON "settlement_period_events" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "settlement_period_events_no_truncate" BEFORE TRUNCATE ON "settlement_period_events" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
-- Per order cost rules are write once (spec 0002, A4): a change is a newer rule row.
CREATE TRIGGER "order_cost_rules_append_only" BEFORE UPDATE OR DELETE ON "order_cost_rules" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "order_cost_rules_no_truncate" BEFORE TRUNCATE ON "order_cost_rules" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
-- Audit entries are write once (spec 0010, AC-8): a correction is a new entry that undoes it.
CREATE TRIGGER "audit_entries_append_only" BEFORE UPDATE OR DELETE ON "audit_entries" FOR EACH ROW EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint
CREATE TRIGGER "audit_entries_no_truncate" BEFORE TRUNCATE ON "audit_entries" FOR EACH STATEMENT EXECUTE FUNCTION "ssd_reject_change"();--> statement-breakpoint

-- `recorded_at` on an append only table belongs to the database (security review S1): a writer's
-- value is always overwritten, because a wrong one could never be corrected and would win "latest"
-- or replay order for ever. Historical time goes in `effective_at` or `effective_from`. The
-- argument picks the clock:
--   'transaction': now(), the transaction start. The stock ledger and credit entries, where every
--     row of one posting carries the same instant (movements copy their group's, the ledger's
--     FutureDate check compares effective_at with it, and nothing picks a "latest" row by it).
--   'statement': clock_timestamp(), the moment of the insert. Tables whose latest row or replay
--     order is read by recorded_at (cost records, cost rules, order events, period events, match
--     rows, merges, audit entries): rows of one transaction keep their insert order, and a row
--     inserted after another committed one is never dated before it.
-- Each trigger's name puts `0_` after the table, so it fires before every other insert trigger of
-- its table (triggers of one event fire in name order) and they all see the final value.
CREATE FUNCTION "ssd_stamp_recorded_at"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_ARGV[0] = 'transaction' THEN
    NEW.recorded_at := now();
  ELSIF TG_ARGV[0] = 'statement' THEN
    NEW.recorded_at := clock_timestamp();
  ELSE
    RAISE EXCEPTION 'ssd_stamp_recorded_at: unknown clock % on %', TG_ARGV[0], TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "movement_groups_0_stamp_recorded_at" BEFORE INSERT ON "movement_groups" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('transaction');--> statement-breakpoint
CREATE TRIGGER "stock_movements_0_stamp_recorded_at" BEFORE INSERT ON "stock_movements" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('transaction');--> statement-breakpoint
CREATE TRIGGER "credit_entries_0_stamp_recorded_at" BEFORE INSERT ON "credit_entries" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('transaction');--> statement-breakpoint
CREATE TRIGGER "cost_records_0_stamp_recorded_at" BEFORE INSERT ON "cost_records" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('statement');--> statement-breakpoint
CREATE TRIGGER "order_cost_rules_0_stamp_recorded_at" BEFORE INSERT ON "order_cost_rules" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('statement');--> statement-breakpoint
CREATE TRIGGER "order_events_0_stamp_recorded_at" BEFORE INSERT ON "order_events" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('statement');--> statement-breakpoint
CREATE TRIGGER "customer_merges_0_stamp_recorded_at" BEFORE INSERT ON "customer_merges" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('statement');--> statement-breakpoint
CREATE TRIGGER "settlement_line_matches_0_stamp_recorded_at" BEFORE INSERT ON "settlement_line_matches" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('statement');--> statement-breakpoint
CREATE TRIGGER "settlement_period_events_0_stamp_recorded_at" BEFORE INSERT ON "settlement_period_events" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('statement');--> statement-breakpoint
-- An audit entry's instant and id are the database's, never the writer's (spec 0010 security
-- review AS1): the shared stamp sets recorded_at (clock_timestamp(), so entries of one transaction
-- keep their order), then audit_entries_1_stamp_id sets the id, both before
-- audit_entries_stamp_operating_day (name order). No writer can backdate or forward date an
-- entry, its operating day, or its place in the (recorded_at, id) keyset order.
CREATE TRIGGER "audit_entries_0_stamp_recorded_at" BEFORE INSERT ON "audit_entries" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_recorded_at"('statement');--> statement-breakpoint
CREATE FUNCTION "audit_entries_stamp_id"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.id := pg_catalog.uuidv7();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_entries_1_stamp_id" BEFORE INSERT ON "audit_entries" FOR EACH ROW EXECUTE FUNCTION "audit_entries_stamp_id"();--> statement-breakpoint

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
CREATE TRIGGER "orders_stamp_operating_day" BEFORE INSERT OR UPDATE OF "placed_at" ON "orders" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_operating_day"('placed_at');--> statement-breakpoint
CREATE TRIGGER "order_events_stamp_operating_day" BEFORE INSERT OR UPDATE OF "occurred_at" ON "order_events" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_operating_day"('occurred_at');--> statement-breakpoint
CREATE TRIGGER "credit_entries_stamp_operating_day" BEFORE INSERT OR UPDATE OF "effective_at" ON "credit_entries" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_operating_day"('effective_at');--> statement-breakpoint
CREATE TRIGGER "tasks_stamp_operating_day" BEFORE INSERT OR UPDATE OF "created_at" ON "tasks" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_operating_day"('created_at');--> statement-breakpoint
-- An audit entry's day comes from recorded_at (spec 0010, AC-7); the entry is never updated, so the
-- UPDATE OF arm never fires past audit_entries_append_only (name order).
CREATE TRIGGER "audit_entries_stamp_operating_day" BEFORE INSERT OR UPDATE OF "recorded_at" ON "audit_entries" FOR EACH ROW EXECUTE FUNCTION "ssd_stamp_operating_day"('recorded_at');--> statement-breakpoint
-- An order is the first updatable stamped table: its operating day changes only through placed_at
-- (security review m3, m1). The guard runs before the stamp trigger (triggers fire in name order),
-- so a placed_at change still restamps the day. A day is never restated otherwise.
CREATE FUNCTION "orders_reject_operating_day_change"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'orders_operating_day_follows_placed_at: the operating day of order % changes only with placed_at', OLD.id
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'orders_operating_day_follows_placed_at';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "orders_operating_day_follows_placed_at" BEFORE UPDATE ON "orders" FOR EACH ROW WHEN (OLD."operating_day" IS DISTINCT FROM NEW."operating_day" AND OLD."placed_at" IS NOT DISTINCT FROM NEW."placed_at") EXECUTE FUNCTION "orders_reject_operating_day_change"();--> statement-breakpoint
-- A task is updatable too (assign, reschedule, close), so the same guard ties its operating day to
-- created_at. It runs before tasks_stamp_operating_day (name order).
CREATE FUNCTION "tasks_reject_operating_day_change"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'tasks_operating_day_follows_created_at: the operating day of task % changes only with created_at', OLD.id
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'tasks_operating_day_follows_created_at';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "tasks_operating_day_follows_created_at" BEFORE UPDATE ON "tasks" FOR EACH ROW WHEN (OLD."operating_day" IS DISTINCT FROM NEW."operating_day" AND OLD."created_at" IS NOT DISTINCT FROM NEW."created_at") EXECUTE FUNCTION "tasks_reject_operating_day_change"();--> statement-breakpoint

-- A location's owner type and party are fixed for its life (spec 0002, A13). A showroom that
-- closes, or a partner that becomes a wholesale customer, gets a new location.
CREATE FUNCTION "locations_reject_owner_change"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'OwnerTypeFixed: the owner type and party of location % cannot change', OLD.code
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'locations_owner_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "locations_owner_fixed" BEFORE UPDATE ON "locations" FOR EACH ROW WHEN (OLD."owner_type" IS DISTINCT FROM NEW."owner_type" OR OLD."party_id" IS DISTINCT FROM NEW."party_id") EXECUTE FUNCTION "locations_reject_owner_change"();--> statement-breakpoint

-- A reversal group can never itself be reversed. The original is read here and one this statement
-- cannot see is refused (security review S6): left to the foreign key, which runs later on a newer
-- snapshot, an original that commits in between would skip this check. FOR KEY SHARE is not used:
-- it needs UPDATE on the table, which the app role never holds on append only history.
CREATE FUNCTION "movement_groups_reject_reversal_of_reversal"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  original_reverses uuid;
BEGIN
  IF NEW.reverses_group_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT reverses_group_id INTO original_reverses FROM public.movement_groups WHERE id = NEW.reverses_group_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'movement_groups_reverses_existing_group: movement group % does not exist or is not committed yet, so it cannot be reversed', NEW.reverses_group_id
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'movement_groups_reverses_existing_group';
  END IF;
  IF original_reverses IS NOT NULL THEN
    RAISE EXCEPTION 'movement group % is a reversal and cannot be reversed', NEW.reverses_group_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "movement_groups_no_reversal_of_reversal" BEFORE INSERT ON "movement_groups" FOR EACH ROW EXECUTE FUNCTION "movement_groups_reject_reversal_of_reversal"();--> statement-breakpoint

-- An undo names a merge of the same two customers (spec 0002, customers child, "The database
-- guards the undo"), so an append only undo row can never point at the wrong merge. An undo with
-- no target is left to the check customer_merges_undo_names_merge.
CREATE FUNCTION "customer_merges_reject_mismatched_undo"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.action = 'undo' AND NEW.undoes_merge_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.customer_merges m
     WHERE m.id = NEW.undoes_merge_id AND m.action = 'merge'
       AND m.survivor_id = NEW.survivor_id AND m.merged_id = NEW.merged_id
  ) THEN
    RAISE EXCEPTION 'customer_merges_undo_matches: undo % must name a merge of the same survivor and merged customer', NEW.id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'customer_merges_undo_matches';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "customer_merges_undo_matches" BEFORE INSERT ON "customer_merges" FOR EACH ROW EXECUTE FUNCTION "customer_merges_reject_mismatched_undo"();--> statement-breakpoint

-- An audit undo names a real, undoable entry of the same record (spec 0010 AC-14, security review
-- AS5): an entry with undoes_entry_id carries a reason, and its target has the same tenant, record
-- type, and record id, an undo_action (the registry marked it undoable when it was written), and
-- the action that this entry's code undoes (`<target action>_undone`). So no insert can claim an
-- entry it does not undo and block the real undo forever (the unique index lets each entry be
-- undone once). An entry whose code ends in _undone must name its target. A target this statement
-- cannot see is refused here, not left to the foreign key.
CREATE FUNCTION "audit_entries_reject_mismatched_undo"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.undoes_entry_id IS NULL THEN
    RAISE EXCEPTION 'audit_entries_undo_matches: an undone entry (%) must name the entry it undoes', NEW.action
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'audit_entries_undo_matches';
  END IF;
  IF NEW.reason IS NULL THEN
    RAISE EXCEPTION 'audit_entries_undo_matches: an undo of entry % must carry a reason', NEW.undoes_entry_id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'audit_entries_undo_matches';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.audit_entries t
     WHERE t.id = NEW.undoes_entry_id
       AND t.tenant_id = NEW.tenant_id
       AND t.record_type = NEW.record_type AND t.record_id = NEW.record_id
       AND t.undo_action IS NOT NULL
       AND NEW.action = t.action || '_undone'
  ) THEN
    RAISE EXCEPTION 'audit_entries_undo_matches: entry % is not an undoable entry of the same record whose action this undo names', NEW.undoes_entry_id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'audit_entries_undo_matches';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_entries_undo_matches" BEFORE INSERT ON "audit_entries" FOR EACH ROW WHEN (NEW."undoes_entry_id" IS NOT NULL OR right(NEW."action", 7) = '_undone') EXECUTE FUNCTION "audit_entries_reject_mismatched_undo"();--> statement-breakpoint

-- A credit reversal can never itself be reversed (spec 0002, customers child), like movement groups.
-- An original this statement cannot see is refused here, not left to the foreign key (S6, above).
-- This trigger runs before credit_entries_reversal_mirrors_original (name order), so the mirror
-- check always finds its original.
CREATE FUNCTION "credit_entries_reject_reversal_of_reversal"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  -- An entry that names itself is left to the check credit_entries_not_reversing_self.
  IF NEW.reverses_entry_id IS NOT NULL AND NEW.reverses_entry_id <> NEW.id AND NOT EXISTS (
    SELECT 1 FROM public.credit_entries WHERE id = NEW.reverses_entry_id
  ) THEN
    RAISE EXCEPTION 'credit_entries_reverses_existing_entry: credit entry % does not exist or is not committed yet, so it cannot be reversed', NEW.reverses_entry_id
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'credit_entries_reverses_existing_entry';
  END IF;
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.credit_entries WHERE id = NEW.reverses_entry_id AND reverses_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'credit_entries_no_reversal_of_reversal: credit entry % is a reversal and cannot be reversed', NEW.reverses_entry_id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'credit_entries_no_reversal_of_reversal';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "credit_entries_no_reversal_of_reversal" BEFORE INSERT ON "credit_entries" FOR EACH ROW EXECUTE FUNCTION "credit_entries_reject_reversal_of_reversal"();--> statement-breakpoint
-- A reversal has the original's kind and funding and the negated amount (spec 0002, customers
-- child), so a reversal always brings its funding's balance back exactly. It also carries the
-- original's customer, order, line, quantity, exchange, refund, and payout method (security review
-- MJ1), so units credited net of reversals stay exact. The composite foreign key
-- (reverses_entry_id, customer_id) pins the customer too; a missing original is left to it.
CREATE FUNCTION "credit_entries_reject_mismatched_reversal"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.reverses_entry_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.credit_entries o
     WHERE o.id = NEW.reverses_entry_id
       AND (o.kind <> NEW.kind OR o.funding <> NEW.funding OR o.amount <> -NEW.amount
            OR o.customer_id <> NEW.customer_id
            OR o.order_id IS DISTINCT FROM NEW.order_id
            OR o.order_line_id IS DISTINCT FROM NEW.order_line_id
            OR o.quantity IS DISTINCT FROM NEW.quantity
            OR o.exchange_id IS DISTINCT FROM NEW.exchange_id
            OR o.refund_id IS DISTINCT FROM NEW.refund_id
            OR o.payout_method IS DISTINCT FROM NEW.payout_method)
  ) THEN
    RAISE EXCEPTION 'credit_entries_reversal_mirrors_original: reversal % must carry the customer, kind, funding, order, line, quantity, exchange, refund, payout method, and negated amount of entry %', NEW.id, NEW.reverses_entry_id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'credit_entries_reversal_mirrors_original';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "credit_entries_reversal_mirrors_original" BEFORE INSERT ON "credit_entries" FOR EACH ROW EXECUTE FUNCTION "credit_entries_reject_mismatched_reversal"();--> statement-breakpoint
-- The entries of one posting share their idempotency key, posting id, customer, and request hash
-- (security review m2), so a replay for another customer, or with other content, can never add
-- entries to an existing posting. An exclusion constraint, not a trigger check (review R16): two
-- entries with one tenant and key conflict unless customer, posting, and hash are all equal. Like a
-- unique key it waits for an uncommitted conflicting entry and then refuses, under every isolation
-- level (security review S6 and S12, review R6), and it takes no lock per entry, so a posting of
-- thousands of entries never fills the lock table (an advisory lock per entry did, R16). The three
-- columns are compared as one text: both uuids are 36 characters, so the text differs exactly when
-- one of them does, and one GiST index serves the check (btree_gist, 0000, gives text `=` and `<>`).
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_posting_holds_together" EXCLUDE USING gist ("tenant_id" WITH =, "idempotency_key" WITH =, (("customer_id"::text || "posting_id"::text) || "request_hash") WITH <>);--> statement-breakpoint

-- Periods of one account never overlap (spec 0002, settlement child), so the period a line's
-- occurred_on falls in is unique. Drizzle cannot express an exclusion constraint; btree_gist
-- (0000) gives uuid its = operator class for GiST.
ALTER TABLE "settlement_periods" ADD CONSTRAINT "settlement_periods_no_overlap" EXCLUDE USING gist ("account_id" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&);--> statement-breakpoint
-- A closed period's dates cannot change (domain re-review n2): narrowing or widening it needs a
-- revoke first, so lines never move out of a period after its evidence was recorded.
CREATE FUNCTION "settlement_periods_reject_closed_date_change"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'PeriodClosed: the dates of closed settlement period % cannot change; revoke the close first', OLD.id
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'settlement_periods_closed_dates_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "settlement_periods_closed_dates_fixed" BEFORE UPDATE ON "settlement_periods" FOR EACH ROW WHEN (OLD."status" = 'closed' AND (OLD."starts_on" IS DISTINCT FROM NEW."starts_on" OR OLD."ends_on" IS DISTINCT FROM NEW."ends_on")) EXECUTE FUNCTION "settlement_periods_reject_closed_date_change"();--> statement-breakpoint
-- A period's status is its latest event's result, no events being open (security review MJ2): an
-- event insert sets it (below), and an insert or update that disagrees with the latest event is
-- refused, so a close can only be undone by a revoke event with its reason.
CREATE FUNCTION "settlement_periods_reject_status_without_event"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  latest text;
BEGIN
  SELECT CASE e.action WHEN 'closed' THEN 'closed' ELSE 'open' END INTO latest
    FROM public.settlement_period_events e
   WHERE e.period_id = NEW.id
   ORDER BY e.recorded_at DESC, e.id DESC
   LIMIT 1;
  IF NEW.status::text IS DISTINCT FROM coalesce(latest, 'open') THEN
    RAISE EXCEPTION 'settlement_periods_status_follows_events: settlement period % is % by its events; write a closed or revoked event instead', NEW.id, coalesce(latest, 'open')
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'settlement_periods_status_follows_events';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "settlement_periods_status_follows_events" BEFORE INSERT OR UPDATE OF "status" ON "settlement_periods" FOR EACH ROW EXECUTE FUNCTION "settlement_periods_reject_status_without_event"();--> statement-breakpoint
CREATE FUNCTION "settlement_period_events_set_status"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.settlement_periods
     SET status = CASE NEW.action WHEN 'closed' THEN 'closed'::public.settlement_period_status
                                  ELSE 'open'::public.settlement_period_status END
   WHERE id = NEW.period_id;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "settlement_period_events_set_status" AFTER INSERT ON "settlement_period_events" FOR EACH ROW EXECUTE FUNCTION "settlement_period_events_set_status"();--> statement-breakpoint
-- A period belongs to one account for life (security review MJ2), so a closed range never comes to
-- cover another account's lines.
CREATE FUNCTION "settlement_periods_reject_account_change"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'settlement_periods_account_fixed: the account of settlement period % cannot change', OLD.id
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'settlement_periods_account_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "settlement_periods_account_fixed" BEFORE UPDATE ON "settlement_periods" FOR EACH ROW WHEN (OLD."account_id" IS DISTINCT FROM NEW."account_id") EXECUTE FUNCTION "settlement_periods_reject_account_change"();--> statement-breakpoint
-- A period is never deleted, by any role (the app role also has no DELETE or TRUNCATE).
CREATE FUNCTION "settlement_periods_reject_delete"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'settlement_periods_never_deleted: a settlement period is never removed (%); revoke its close instead', TG_OP
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'settlement_periods_never_deleted';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "settlement_periods_never_deleted" BEFORE DELETE ON "settlement_periods" FOR EACH ROW EXECUTE FUNCTION "settlement_periods_reject_delete"();--> statement-breakpoint
CREATE TRIGGER "settlement_periods_no_truncate" BEFORE TRUNCATE ON "settlement_periods" FOR EACH STATEMENT EXECUTE FUNCTION "settlement_periods_reject_delete"();--> statement-breakpoint
-- A settlement account's owner is fixed for life (security review m5), like a location's: moving a
-- partner's statements and debt to another owner needs a new account.
CREATE FUNCTION "settlement_accounts_reject_owner_change"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'SettlementOwnerFixed: the owner of settlement account % cannot change; archive it and open another', OLD.code
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'settlement_accounts_owner_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "settlement_accounts_owner_fixed" BEFORE UPDATE ON "settlement_accounts" FOR EACH ROW WHEN (OLD."owner_type" IS DISTINCT FROM NEW."owner_type" OR OLD."owner_connection_id" IS DISTINCT FROM NEW."owner_connection_id" OR OLD."owner_party_id" IS DISTINCT FROM NEW."owner_party_id") EXECUTE FUNCTION "settlement_accounts_reject_owner_change"();--> statement-breakpoint
-- A line's match rows are one chain (security review m4, n2): the first row supersedes nothing,
-- every later row supersedes the current head (the row no other row supersedes), and an
-- `accounted` row is terminal, with one exception (domain review D1, gate ruling): a `cleared` row
-- with the reason `superseded`, once a statement supersedes the line's statement. A `cleared` row
-- is terminal without exception (review R17). The composite key
-- (supersedes_match_id, line_id) keeps the chain on its line, and the unique supersedes_match_id
-- serializes two matchers racing for one head.
CREATE FUNCTION "settlement_line_matches_reject_off_chain"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  target_result text;
BEGIN
  IF NEW.supersedes_match_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.settlement_line_matches WHERE line_id = NEW.line_id) THEN
      RAISE EXCEPTION 'settlement_line_matches_extends_chain: line % already has match rows; a new row supersedes the current one', NEW.line_id
        USING ERRCODE = 'restrict_violation', CONSTRAINT = 'settlement_line_matches_extends_chain';
    END IF;
    RETURN NEW;
  END IF;
  SELECT m.result::text INTO target_result
    FROM public.settlement_line_matches m
   WHERE m.id = NEW.supersedes_match_id AND m.line_id = NEW.line_id;
  IF NOT FOUND THEN
    -- Another line's row, or none: the composite foreign key refuses it.
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.settlement_line_matches WHERE supersedes_match_id = NEW.supersedes_match_id) THEN
    RAISE EXCEPTION 'settlement_line_matches_extends_chain: match row % is already superseded; supersede the current head of line %', NEW.supersedes_match_id, NEW.line_id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'settlement_line_matches_extends_chain';
  END IF;
  IF target_result = 'accounted' AND NOT (
    NEW.result = 'cleared' AND NEW.reason_code = 'superseded' AND EXISTS (
      SELECT 1 FROM public.settlement_lines l
        JOIN public.settlement_statements s ON s.supersedes_statement_id = l.statement_id
       WHERE l.id = NEW.line_id)
  ) THEN
    RAISE EXCEPTION 'settlement_line_matches_accounted_terminal: match row % accounted line %, which is final; only a cleared row with the reason superseded may follow, once its statement is superseded', NEW.supersedes_match_id, NEW.line_id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'settlement_line_matches_accounted_terminal';
  END IF;
  -- A cleared line belongs to a superseded statement, so nothing follows a cleared row (review R17).
  IF target_result = 'cleared' THEN
    RAISE EXCEPTION 'settlement_line_matches_cleared_terminal: match row % cleared line %, which is final', NEW.supersedes_match_id, NEW.line_id
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'settlement_line_matches_cleared_terminal';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "settlement_line_matches_extends_chain" BEFORE INSERT ON "settlement_line_matches" FOR EACH ROW EXECUTE FUNCTION "settlement_line_matches_reject_off_chain"();--> statement-breakpoint

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
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON "movement_groups", "stock_movements", "movement_serials", "stock_receipt_lines", "cost_records", "order_events", "customer_merges", "credit_entries", "settlement_statements", "settlement_lines", "settlement_line_matches", "settlement_period_events", "order_cost_rules", "audit_entries" FROM %I', app_role);
  -- A settlement period is never deleted (a trigger refuses it for every role too); the app role
  -- keeps UPDATE, which the period triggers limit to the dates of an open period.
  EXECUTE format('REVOKE DELETE, TRUNCATE ON "settlement_periods" FROM %I', app_role);
  -- A task is cancelled, never deleted.
  EXECUTE format('REVOKE DELETE, TRUNCATE ON "tasks" FROM %I', app_role);
  -- Receipts are never deleted; the app role keeps UPDATE for the void columns (spec 0006).
  EXECUTE format('REVOKE DELETE, TRUNCATE ON "stock_receipts" FROM %I', app_role);
  -- Outbound commands are the single truth for open edits: a failed one is resolved, never removed.
  EXECUTE format('REVOKE DELETE, TRUNCATE ON "outbound_commands" FROM %I', app_role);
  -- The owner type policy is read only for the app role until feature 9 grants editing back.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "location_owner_policies" FROM %I', app_role);
  -- Only migrate writes the install row.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "install" FROM %I', app_role);
  -- A sign in slot is taken and given back, never changed (spec 0005, AC-3).
  EXECUTE format('REVOKE UPDATE ON "sign_in_slots" FROM %I', app_role);
  -- Hats and extra grants are current state: a change inserts or deletes a row, never updates one
  -- (spec 0008, data model). The audit trail holds their history.
  EXECUTE format('REVOKE UPDATE, TRUNCATE ON "hat_assignments", "permission_grants" FROM %I', app_role);
END;
$$;--> statement-breakpoint

-- AC-16 role mapping: begin
-- Spec 0008, AC-16: the two roles before hats become hats. `admin` is `manager` plus the
-- `cost.view` grant; `staff` is `support`, `operations` and `warehouse`, still without cost. Then
-- every role is `user`, the only value the `users_role_check` allows. On a fresh database there is
-- no person yet, so all three statements change nothing; `granted_by` stays null (the migration
-- gave them). `packages/db/test/hats.e2e-spec.ts` runs this block on planted people.
INSERT INTO "hat_assignments" ("user_id", "hat")
  SELECT "id", 'manager' FROM "users" WHERE "role" = 'admin'
  UNION ALL
  SELECT u."id", h."hat" FROM "users" u
    CROSS JOIN (VALUES ('support'), ('operations'), ('warehouse')) AS h ("hat")
    WHERE u."role" = 'staff'
ON CONFLICT ("tenant_id", "user_id", "hat") DO NOTHING;--> statement-breakpoint
INSERT INTO "permission_grants" ("user_id", "permission")
  SELECT "id", 'cost.view' FROM "users" WHERE "role" = 'admin'
ON CONFLICT ("tenant_id", "user_id", "permission") DO NOTHING;--> statement-breakpoint
UPDATE "users" SET "role" = 'user' WHERE "role" <> 'user';--> statement-breakpoint
-- AC-16 role mapping: end

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
  ('wholesale_customer', false, true, 'at_handover', 'location_owner', 'location_owner', 'b2b_electronic_invoice_at_handover', NULL, false);--> statement-breakpoint
-- The internal store for manual, landing page, and WhatsApp orders, and the manual channel that
-- lands in it (spec 0002, orders child).
INSERT INTO "stores" ("code", "name", "public_name", "kind") VALUES
  ('MAIN', '{"en": "Main store", "ar": "المتجر الرئيسي"}', '{"en": "Main store", "ar": "المتجر الرئيسي"}', 'internal');--> statement-breakpoint
INSERT INTO "channels" ("code", "name", "kind", "default_store_id")
  SELECT 'manual', '{"en": "Manual", "ar": "يدوي"}', 'manual', "id" FROM "stores" WHERE "code" = 'MAIN';
