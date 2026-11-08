-- Hand written (spec 0014, milestone 1): what Drizzle cannot express for the customer tables of
-- 0006_customers_by_phone.sql. Edited by hand, never generated.

-- Expand and contract: 0006 added `customers.risk_flag_set_at` empty and left its check out on
-- purpose. Any customer flagged before the column existed gets the time of its last change (its
-- creation time when it never changed), so 0008_customers_flag_set_at_check.sql, which adds the
-- check `(risk_flag IS NULL) = (risk_flag_set_at IS NULL)`, never meets a flagged row without one.
UPDATE "customers"
SET "risk_flag_set_at" = coalesce("updated_at", "created_at")
WHERE "risk_flag" IS NOT NULL AND "risk_flag_set_at" IS NULL;--> statement-breakpoint

-- A merge suggestion is closed, never removed: a pair has one row ever, so a dismissed pair is
-- never suggested again. The application role may insert, read, and update it, never delete or
-- truncate it (the default privileges of 0002 granted DELETE).
DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app');
BEGIN
  EXECUTE format('REVOKE DELETE, TRUNCATE ON "customer_merge_suggestions" FROM %I', app_role);
END;
$$;
