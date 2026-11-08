-- Spec 0009 AC-24 (owner ruling 2026-11-08): a holder of settings.manage edits the location owner
-- type policy rows through LocationPolicyService.updatePolicy, so the application role gets back
-- the right the baseline (0002) held from it, and only that right: UPDATE of the eight policy
-- attributes, of who changed it when, and of when a locked term last changed (0011). Never
-- INSERT, DELETE, or TRUNCATE (the three rows are seeded and only ever edited), and never
-- `owner_type` or `tenant_id` (the row's identity). The CHECKs of 0011 keep every row consistent
-- whoever writes it, so the api cannot offer partner or customer stock online even past its own
-- rules.
DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('ssd.app_role', true), ''), 'ssdashboard_app');
BEGIN
  EXECUTE format(
    'GRANT UPDATE ("stock_owned_by_brand", "handover_is_sale", "sale_recorded_at", '
    '"end_customer_refund_by", "defective_piece_refund_by", "tax_document", '
    '"settlement_owner_type", "can_sell_online", "updated_at", "updated_by", '
    '"locked_terms_changed_at") '
    'ON "location_owner_policies" TO %I',
    app_role
  );
END;
$$;
