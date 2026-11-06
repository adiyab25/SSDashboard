CREATE TYPE "public"."cost_basis" AS ENUM('factory_invoice', 'production_run', 'purchase_landed', 'estimate');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."variant_kind" AS ENUM('stocked', 'service', 'bundle');--> statement-breakpoint
CREATE TYPE "public"."variant_tracking" AS ENUM('none', 'lot', 'serial');--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('shopify', 'landing_page', 'manual', 'whatsapp', 'instagram', 'consignment_partner', 'wholesale');--> statement-breakpoint
CREATE TYPE "public"."store_kind" AS ENUM('shopify', 'internal');--> statement-breakpoint
CREATE TYPE "public"."connection_provider" AS ENUM('shopify', 'bosta', 'gateway', 'meta', 'whatsapp', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('active', 'paused', 'restricted', 'archived');--> statement-breakpoint
CREATE TYPE "public"."outbound_linked_type" AS ENUM('order', 'customer', 'variant', 'exchange', 'refund');--> statement-breakpoint
CREATE TYPE "public"."outbound_resolution" AS ENUM('retried', 'fixed_in_provider', 'edit_undone');--> statement-breakpoint
CREATE TYPE "public"."outbound_sync_state" AS ENUM('waiting', 'synced', 'failed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."credit_actor_type" AS ENUM('person', 'rule', 'system_job', 'import');--> statement-breakpoint
CREATE TYPE "public"."credit_entry_kind" AS ENUM('return_credit', 'shipping_credit', 'order_consumption', 'refund_payout', 'retention_bonus', 'goodwill', 'opening_balance', 'inspection_reversal', 'return_not_collected', 'consumption_release', 'debt_payment', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."credit_funding" AS ENUM('cod_cash', 'gateway', 'instapay_or_transfer', 'credit_only');--> statement-breakpoint
CREATE TYPE "public"."credit_payout_method" AS ENUM('carrier_cash_refund', 'gateway_refund', 'instapay_or_transfer');--> statement-breakpoint
CREATE TYPE "public"."customer_external_id_kind" AS ENUM('shopify_customer', 'partner_reference', 'whatsapp_contact');--> statement-breakpoint
CREATE TYPE "public"."customer_merge_action" AS ENUM('merge', 'undo');--> statement-breakpoint
CREATE TYPE "public"."customer_phone_kind" AS ENUM('mobile', 'landline', 'foreign');--> statement-breakpoint
CREATE TYPE "public"."customer_risk_flag" AS ENUM('returner', 'refuser', 'fake', 'abusive');--> statement-breakpoint
CREATE TYPE "public"."customer_risk_flag_source" AS ENUM('blacklist_import', 'manual', 'rule');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_kind" AS ENUM('balance', 'reservation', 'serial');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_resolution" AS ENUM('rebuilt', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."movement_source_type" AS ENUM('opening_balance', 'stock_receipt', 'purchase_receipt', 'purchase_return', 'order_shipment', 'returned_to_origin_restock', 'customer_return_restock', 'exchange_return_restock', 'consignment_sale', 'write_off', 'transfer_out', 'transfer_in', 'adjustment', 'count', 'production_consume', 'production_output');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('active', 'released', 'fulfilled');--> statement-breakpoint
CREATE TYPE "public"."serial_status" AS ENUM('in_stock', 'out');--> statement-breakpoint
CREATE TYPE "public"."bin_level" AS ENUM('zone', 'aisle', 'shelf', 'bin');--> statement-breakpoint
CREATE TYPE "public"."location_kind" AS ENUM('warehouse', 'shop', 'transit', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."location_owner_type" AS ENUM('own', 'consignment_partner', 'wholesale_customer');--> statement-breakpoint
CREATE TYPE "public"."refund_by" AS ENUM('brand', 'location_owner');--> statement-breakpoint
CREATE TYPE "public"."sale_recorded_at" AS ENUM('at_shipment', 'at_sell_through', 'at_handover');--> statement-breakpoint
CREATE TYPE "public"."settlement_owner_type" AS ENUM('carrier', 'consignment_partner', 'gateway');--> statement-breakpoint
CREATE TYPE "public"."tax_document" AS ENUM('b2c_electronic_receipt', 'b2b_electronic_invoice_at_settlement', 'b2b_electronic_invoice_at_handover');--> statement-breakpoint
CREATE TYPE "public"."order_actor_type" AS ENUM('person', 'carrier', 'system_job', 'import');--> statement-breakpoint
CREATE TYPE "public"."order_cash_state" AS ENUM('unpaid', 'collected_by_carrier', 'remitted', 'reconciled', 'prepaid', 'nothing_to_collect');--> statement-breakpoint
CREATE TYPE "public"."order_fulfillment_state" AS ENUM('new', 'confirmed', 'packed', 'shipped', 'delivered', 'partially_delivered', 'failed_attempt', 'returned_to_origin', 'exchanged', 'refused', 'cancelled', 'lost');--> statement-breakpoint
CREATE TYPE "public"."order_line_state" AS ENUM('open', 'cancelled', 'delivered', 'returned_to_origin', 'returned', 'lost');--> statement-breakpoint
CREATE TYPE "public"."order_machine" AS ENUM('fulfillment', 'cash');--> statement-breakpoint
CREATE TYPE "public"."order_outcome" AS ENUM('open', 'kept', 'cancelled_before_shipping', 'failed_delivery', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."order_payment_method" AS ENUM('cod', 'gateway', 'instapay', 'bank_transfer', 'wallet', 'none');--> statement-breakpoint
CREATE TYPE "public"."order_relation" AS ENUM('duplicate_of', 'reopened_from');--> statement-breakpoint
CREATE TYPE "public"."order_source_captured_from" AS ENUM('landing_page', 'shopify_journey', 'whatsapp_thread', 'manual', 'none');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('sale', 'exchange_replacement', 'gifted');--> statement-breakpoint
CREATE TYPE "public"."order_write_back_state" AS ENUM('none', 'waiting', 'failed');--> statement-breakpoint
CREATE TYPE "public"."custom_field_type" AS ENUM('text', 'number', 'boolean', 'date', 'select');--> statement-breakpoint
CREATE TYPE "public"."order_cost_rule_kind" AS ENUM('cod_fee_percent', 'gateway_fee_percent', 'packaging_per_order', 'rto_unrestocked_percent');--> statement-breakpoint
CREATE TYPE "public"."order_cost_rule_status" AS ENUM('set', 'not_set');--> statement-breakpoint
CREATE TYPE "public"."settlement_line_kind" AS ENUM('cod_collected', 'cod_fee', 'shipping_fee', 'opening_package_fee', 'other_fee', 'fee_vat', 'customer_refund', 'compensation', 'deposit', 'consignment_sale', 'consignment_return', 'defective_return_credit', 'missing_piece_charge', 'partner_payment', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."settlement_match_result" AS ENUM('matched', 'accounted', 'unmatched', 'cleared');--> statement-breakpoint
CREATE TYPE "public"."settlement_matched_by_type" AS ENUM('rule', 'person');--> statement-breakpoint
CREATE TYPE "public"."settlement_period_action" AS ENUM('closed', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."settlement_period_actor_type" AS ENUM('person', 'rule');--> statement-breakpoint
CREATE TYPE "public"."settlement_period_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."settlement_statement_kind" AS ENUM('carrier_file', 'carrier_api', 'partner_file', 'partner_upload', 'partner_api', 'count');--> statement-breakpoint
CREATE TYPE "public"."stock_receipt_status" AS ENUM('posted', 'voided');--> statement-breakpoint
CREATE TYPE "public"."task_created_by_type" AS ENUM('person', 'system_job');--> statement-breakpoint
CREATE TYPE "public"."task_linked_type" AS ENUM('order', 'customer', 'exchange', 'refund', 'shipment', 'settlement_line', 'settlement_statement', 'settlement_period', 'outbound_command', 'party', 'location');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("tenant_id","token")
);
--> statement-breakpoint
CREATE TABLE "sign_in_attempts" (
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"email_key" text NOT NULL,
	"scope" text NOT NULL,
	"failures" integer NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "sign_in_attempts_tenant_id_email_key_scope_pk" PRIMARY KEY("tenant_id","email_key","scope")
);
--> statement-breakpoint
CREATE TABLE "sign_in_slots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"email_key" text NOT NULL,
	"ip" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'staff' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"phone" text,
	"staff_code" text,
	"language" text,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin', 'staff'))
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "barcodes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"uom_id" uuid NOT NULL,
	"code" text NOT NULL,
	CONSTRAINT "barcodes_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "cost_records" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"season_id" uuid NOT NULL,
	"cost_basis" "cost_basis" NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"effective_from" date NOT NULL,
	"source" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	CONSTRAINT "cost_records_unit_cost_not_negative" CHECK ("cost_records"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "product_groups_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "product_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"position" integer NOT NULL,
	"values" jsonb NOT NULL,
	CONSTRAINT "product_options_product_position_unique" UNIQUE("tenant_id","product_id","position")
);
--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"option_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kind" "variant_kind" DEFAULT 'stocked' NOT NULL,
	"tracking" "variant_tracking" DEFAULT 'none' NOT NULL,
	"base_uom_id" uuid NOT NULL,
	"price" numeric(14, 2),
	"compare_at_price" numeric(14, 2),
	"weight_grams" integer,
	"length_mm" integer,
	"width_mm" integer,
	"height_mm" integer,
	"hs_code" text,
	"country_of_origin" char(2),
	"requires_shipping" boolean DEFAULT true NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "product_variants_sku_unique" UNIQUE("tenant_id","sku"),
	CONSTRAINT "product_variants_id_product_unique" UNIQUE("id","product_id"),
	CONSTRAINT "product_variants_tracking_stocked_only" CHECK ("product_variants"."tracking" = 'none' OR "product_variants"."kind" = 'stocked')
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"style_code" text NOT NULL,
	"season_id" uuid,
	"product_group_id" uuid NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"brand" text,
	"product_type" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "products_style_code_unique" UNIQUE("tenant_id","style_code")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"archived_at" timestamp with time zone,
	CONSTRAINT "seasons_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "seasons_dates_in_order" CHECK ("seasons"."starts_on" IS NULL OR "seasons"."ends_on" IS NULL OR "seasons"."starts_on" <= "seasons"."ends_on")
);
--> statement-breakpoint
CREATE TABLE "uoms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	CONSTRAINT "uoms_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "variant_uom_conversions" (
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"uom_id" uuid NOT NULL,
	"factor" integer NOT NULL,
	CONSTRAINT "variant_uom_conversions_variant_id_uom_id_pk" PRIMARY KEY("variant_id","uom_id"),
	CONSTRAINT "variant_uom_conversions_factor_above_one" CHECK ("variant_uom_conversions"."factor" > 1)
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"kind" "channel_kind" NOT NULL,
	"default_store_id" uuid,
	"location_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "channels_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"public_name" jsonb NOT NULL,
	"kind" "store_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "stores_code_unique" UNIQUE("tenant_id","code")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"provider" "connection_provider" NOT NULL,
	"label" text NOT NULL,
	"store_id" uuid,
	"status" "connection_status" DEFAULT 'active' NOT NULL,
	"restricted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connections_shopify_needs_store" CHECK ("connections"."provider" <> 'shopify' OR "connections"."store_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "outbound_commands" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"linked_type" "outbound_linked_type" NOT NULL,
	"linked_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"sync_state" "outbound_sync_state" DEFAULT 'waiting' NOT NULL,
	"failure_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"synced_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" "outbound_resolution",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_commands_idempotency_key_unique" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "outbound_commands_resolution_when_resolved" CHECK (("outbound_commands"."sync_state" = 'resolved') = ("outbound_commands"."resolution" IS NOT NULL)),
	CONSTRAINT "outbound_commands_resolved_at_when_resolved" CHECK (("outbound_commands"."sync_state" = 'resolved') = ("outbound_commands"."resolved_at" IS NOT NULL)),
	CONSTRAINT "outbound_commands_attempts_not_negative" CHECK ("outbound_commands"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "credit_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"posting_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "credit_entry_kind" NOT NULL,
	"funding" "credit_funding" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"payout_method" "credit_payout_method",
	"order_id" uuid,
	"order_line_id" uuid,
	"quantity" integer,
	"exchange_id" uuid,
	"refund_id" uuid,
	"reverses_entry_id" uuid,
	"reason_code" text NOT NULL,
	"actor_type" "credit_actor_type" NOT NULL,
	"actor_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operating_day" date NOT NULL,
	CONSTRAINT "credit_entries_id_customer_unique" UNIQUE("id","customer_id"),
	CONSTRAINT "credit_entries_posting_funding_unique" UNIQUE("tenant_id","idempotency_key","funding"),
	CONSTRAINT "credit_entries_reverses_entry_unique" UNIQUE("reverses_entry_id"),
	CONSTRAINT "credit_entries_amount_not_zero" CHECK ("credit_entries"."amount" <> 0),
	CONSTRAINT "credit_entries_not_reversing_self" CHECK ("credit_entries"."reverses_entry_id" IS DISTINCT FROM "credit_entries"."id"),
	CONSTRAINT "credit_entries_line_needs_order" CHECK ("credit_entries"."order_line_id" IS NULL OR "credit_entries"."order_id" IS NOT NULL),
	CONSTRAINT "credit_entries_payout_method_matches_funding" CHECK ("credit_entries"."kind" <> 'refund_payout' OR (("credit_entries"."payout_method" = 'gateway_refund') = ("credit_entries"."funding" = 'gateway'))),
	CONSTRAINT "credit_entries_idempotency_key_shape" CHECK ("credit_entries"."idempotency_key" ~ '^[A-Za-z0-9:_.-]{1,200}$'),
	CONSTRAINT "credit_entries_sign_by_kind" CHECK ("credit_entries"."kind" = 'adjustment'
        OR ("credit_entries"."kind" IN ('return_credit', 'shipping_credit', 'retention_bonus', 'goodwill', 'opening_balance', 'consumption_release', 'debt_payment')) = (("credit_entries"."amount" > 0) = ("credit_entries"."reverses_entry_id" IS NULL))),
	CONSTRAINT "credit_entries_payout_method_on_payout" CHECK (("credit_entries"."kind" = 'refund_payout') = ("credit_entries"."payout_method" IS NOT NULL)),
	CONSTRAINT "credit_entries_payout_never_credit_only" CHECK ("credit_entries"."kind" <> 'refund_payout' OR "credit_entries"."funding" <> 'credit_only'),
	CONSTRAINT "credit_entries_bonus_and_goodwill_credit_only" CHECK ("credit_entries"."kind" NOT IN ('retention_bonus', 'goodwill') OR "credit_entries"."funding" = 'credit_only'),
	CONSTRAINT "credit_entries_return_credit_has_line" CHECK ("credit_entries"."kind" <> 'return_credit' OR ("credit_entries"."order_line_id" IS NOT NULL AND coalesce("credit_entries"."quantity", 0) > 0)),
	CONSTRAINT "credit_entries_consumption_has_order" CHECK ("credit_entries"."kind" NOT IN ('order_consumption', 'consumption_release') OR "credit_entries"."order_id" IS NOT NULL),
	CONSTRAINT "credit_entries_not_collected_has_exchange" CHECK ("credit_entries"."kind" <> 'return_not_collected' OR "credit_entries"."exchange_id" IS NOT NULL),
	CONSTRAINT "credit_entries_person_has_actor" CHECK ("credit_entries"."actor_type" <> 'person' OR "credit_entries"."actor_id" IS NOT NULL),
	CONSTRAINT "credit_entries_reason_code_shape" CHECK ("credit_entries"."reason_code" IS NULL OR "credit_entries"."reason_code" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "customer_external_ids" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "customer_external_id_kind" NOT NULL,
	"connection_id" uuid,
	"channel_id" uuid,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_external_ids_issuer_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","kind","connection_id","channel_id","external_id"),
	CONSTRAINT "customer_external_ids_one_issuer" CHECK (num_nonnulls("customer_external_ids"."connection_id", "customer_external_ids"."channel_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "customer_merges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"action" "customer_merge_action" NOT NULL,
	"survivor_id" uuid NOT NULL,
	"merged_id" uuid NOT NULL,
	"repointed_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"undoes_merge_id" uuid,
	"reason" text,
	"actor_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_merges_undoes_merge_unique" UNIQUE("undoes_merge_id"),
	CONSTRAINT "customer_merges_undo_names_merge" CHECK (("customer_merges"."action" = 'undo') = ("customer_merges"."undoes_merge_id" IS NOT NULL)),
	CONSTRAINT "customer_merges_two_customers" CHECK ("customer_merges"."survivor_id" <> "customer_merges"."merged_id"),
	CONSTRAINT "customer_merges_reason_shape" CHECK ("customer_merges"."reason" IS NULL OR "customer_merges"."reason" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "customer_phones" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"kind" "customer_phone_kind" NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_phones_phone_unique" UNIQUE("tenant_id","phone_e164"),
	CONSTRAINT "customer_phones_e164" CHECK ("customer_phones"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"name" text,
	"merged_into_id" uuid,
	"risk_flag" "customer_risk_flag",
	"risk_flag_source" "customer_risk_flag_source",
	"risk_flag_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_not_merged_into_self" CHECK ("customers"."merged_into_id" <> "customers"."id"),
	CONSTRAINT "customers_risk_flag_has_source" CHECK (("customers"."risk_flag" IS NULL) = ("customers"."risk_flag_source" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lots_variant_code_unique" UNIQUE("tenant_id","variant_id","code"),
	CONSTRAINT "lots_id_variant_unique" UNIQUE("id","variant_id")
);
--> statement-breakpoint
CREATE TABLE "movement_groups" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"source_type" "movement_source_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"reverses_group_id" uuid,
	"effective_at" timestamp with time zone NOT NULL,
	"operating_day" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_by" uuid,
	CONSTRAINT "movement_groups_reverses_group_id_unique" UNIQUE("reverses_group_id"),
	CONSTRAINT "movement_groups_idempotency_key_unique" UNIQUE("tenant_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "movement_serials" (
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"movement_id" uuid NOT NULL,
	"serial_id" uuid NOT NULL,
	CONSTRAINT "movement_serials_movement_id_serial_id_pk" PRIMARY KEY("movement_id","serial_id")
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"lot_id" uuid,
	"quantity" integer NOT NULL,
	"open_quantity" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_line_id" uuid NOT NULL,
	"status" "reservation_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "reservations_quantity_positive" CHECK ("reservations"."quantity" > 0),
	CONSTRAINT "reservations_open_quantity_range" CHECK ("reservations"."open_quantity" >= 0 AND "reservations"."open_quantity" <= "reservations"."quantity"),
	CONSTRAINT "reservations_open_while_active" CHECK (("reservations"."status" = 'active') = ("reservations"."open_quantity" > 0))
);
--> statement-breakpoint
CREATE TABLE "serials" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"lot_id" uuid,
	"status" serial_status NOT NULL,
	"location_id" uuid,
	"bin_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "serials_variant_serial_unique" UNIQUE("tenant_id","variant_id","serial"),
	CONSTRAINT "serials_place_when_in_stock" CHECK (("serials"."status" = 'in_stock') = ("serials"."location_id" IS NOT NULL)),
	CONSTRAINT "serials_bin_needs_location" CHECK ("serials"."bin_id" IS NULL OR "serials"."location_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "stock_level_discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"stock_level_id" uuid,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"bin_id" uuid,
	"lot_id" uuid,
	"kind" "discrepancy_kind" NOT NULL,
	"expected" jsonb NOT NULL,
	"actual" jsonb NOT NULL,
	"found_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution" "discrepancy_resolution"
);
--> statement-breakpoint
CREATE TABLE "stock_levels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"bin_id" uuid,
	"lot_id" uuid,
	"on_hand" integer DEFAULT 0 NOT NULL,
	"avg_unit_cost" numeric(14, 4) DEFAULT '0' NOT NULL,
	"total_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_levels_key_unique" UNIQUE NULLS NOT DISTINCT("variant_id","location_id","bin_id","lot_id"),
	CONSTRAINT "stock_levels_value_sign" CHECK (("stock_levels"."on_hand" = 0 AND "stock_levels"."total_value" = 0) OR ("stock_levels"."on_hand" <> 0 AND ("stock_levels"."total_value" = 0 OR sign("stock_levels"."total_value") = sign("stock_levels"."on_hand"))))
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"bin_id" uuid,
	"lot_id" uuid,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"total_cost" numeric(14, 2) NOT NULL,
	"cost_variance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cost_unknown" boolean DEFAULT false NOT NULL,
	"source_line_id" uuid,
	"reason_code" text,
	"effective_at" timestamp with time zone NOT NULL,
	"operating_day" date NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stock_movements_quantity_not_zero" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_cost_sign" CHECK ("stock_movements"."total_cost" = 0 OR sign("stock_movements"."total_cost") = sign("stock_movements"."quantity")),
	CONSTRAINT "stock_movements_reason_code_shape" CHECK ("stock_movements"."reason_code" IS NULL OR "stock_movements"."reason_code" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "bins" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"parent_id" uuid,
	"level" "bin_level" DEFAULT 'bin' NOT NULL,
	"code" text NOT NULL,
	"is_sellable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "bins_location_code_unique" UNIQUE("tenant_id","location_id","code"),
	CONSTRAINT "bins_id_location_unique" UNIQUE("id","location_id")
);
--> statement-breakpoint
CREATE TABLE "location_owner_policies" (
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"owner_type" "location_owner_type" NOT NULL,
	"stock_owned_by_brand" boolean NOT NULL,
	"handover_is_sale" boolean NOT NULL,
	"sale_recorded_at" "sale_recorded_at" NOT NULL,
	"end_customer_refund_by" "refund_by" NOT NULL,
	"defective_piece_refund_by" "refund_by" NOT NULL,
	"tax_document" "tax_document" NOT NULL,
	"settlement_owner_type" "settlement_owner_type",
	"can_sell_online" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "location_owner_policies_tenant_id_owner_type_pk" PRIMARY KEY("tenant_id","owner_type")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"kind" "location_kind" NOT NULL,
	"owner_type" "location_owner_type" DEFAULT 'own' NOT NULL,
	"party_id" uuid,
	"is_sellable" boolean DEFAULT true NOT NULL,
	"sellable_online" boolean DEFAULT false NOT NULL,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "locations_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "locations_party_matches_owner" CHECK (("locations"."owner_type" = 'own') = ("locations"."party_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"machine" "order_machine" NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"amount" numeric(14, 2),
	"actor_type" "order_actor_type" NOT NULL,
	"actor_id" uuid,
	"reason_code" text,
	"source_type" text,
	"source_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operating_day" date NOT NULL,
	CONSTRAINT "order_events_to_state_of_machine" CHECK (CASE "order_events"."machine"
        WHEN 'fulfillment' THEN pg_input_is_valid("order_events"."to_state", 'public.order_fulfillment_state')
        WHEN 'cash' THEN pg_input_is_valid("order_events"."to_state", 'public.order_cash_state')
      END),
	CONSTRAINT "order_events_from_state_of_machine" CHECK ("order_events"."from_state" IS NULL OR CASE "order_events"."machine"
        WHEN 'fulfillment' THEN pg_input_is_valid("order_events"."from_state", 'public.order_fulfillment_state')
        WHEN 'cash' THEN pg_input_is_valid("order_events"."from_state", 'public.order_cash_state')
      END),
	CONSTRAINT "order_events_amount_on_cash_only" CHECK ("order_events"."amount" IS NULL OR ("order_events"."machine" = 'cash' AND "order_events"."amount" >= 0)),
	CONSTRAINT "order_events_person_has_actor" CHECK ("order_events"."actor_type" <> 'person' OR "order_events"."actor_id" IS NOT NULL),
	CONSTRAINT "order_events_reason_code_shape" CHECK ("order_events"."reason_code" IS NULL OR "order_events"."reason_code" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"variant_id" uuid,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(14, 2) NOT NULL,
	"tax_rate" numeric(5, 2) NOT NULL,
	"tax_amount" numeric(14, 2) NOT NULL,
	"gross_amount" numeric(14, 2) NOT NULL,
	"prepaid_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"credit_applied_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(14, 4),
	"line_state" "order_line_state" DEFAULT 'open' NOT NULL,
	"cancel_reason_code" text,
	"split_from_line_id" uuid,
	"channel_line_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_order_position_unique" UNIQUE("tenant_id","order_id","position"),
	CONSTRAINT "order_lines_id_order_unique" UNIQUE("id","order_id"),
	CONSTRAINT "order_lines_quantity_positive" CHECK ("order_lines"."quantity" > 0),
	CONSTRAINT "order_lines_amounts_not_negative" CHECK ("order_lines"."unit_price" >= 0 AND "order_lines"."discount_amount" >= 0 AND "order_lines"."net_amount" >= 0
        AND "order_lines"."tax_rate" >= 0 AND "order_lines"."tax_amount" >= 0 AND "order_lines"."gross_amount" >= 0
        AND "order_lines"."prepaid_amount" >= 0 AND "order_lines"."credit_applied_amount" >= 0
        AND ("order_lines"."unit_cost" IS NULL OR "order_lines"."unit_cost" >= 0)),
	CONSTRAINT "order_lines_gross_is_net_plus_tax" CHECK ("order_lines"."gross_amount" = "order_lines"."net_amount" + "order_lines"."tax_amount"),
	CONSTRAINT "order_lines_shares_within_gross" CHECK ("order_lines"."prepaid_amount" + "order_lines"."credit_applied_amount" <= "order_lines"."gross_amount"),
	CONSTRAINT "order_lines_cancel_reason_when_cancelled" CHECK (("order_lines"."line_state" = 'cancelled') = ("order_lines"."cancel_reason_code" IS NOT NULL)),
	CONSTRAINT "order_lines_cancel_reason_code_shape" CHECK ("order_lines"."cancel_reason_code" IS NULL OR "order_lines"."cancel_reason_code" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"type" "order_type" DEFAULT 'sale' NOT NULL,
	"original_order_id" uuid,
	"exchange_id" uuid,
	"related_order_id" uuid,
	"related_order_relation" "order_relation",
	"customer_id" uuid,
	"placed_at" timestamp with time zone NOT NULL,
	"operating_day" date NOT NULL,
	"fulfillment_state" "order_fulfillment_state" NOT NULL,
	"cash_state" "order_cash_state" NOT NULL,
	"outcome" "order_outcome" NOT NULL,
	"write_back_state" "order_write_back_state" DEFAULT 'none' NOT NULL,
	"lines_gross_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"shipping_charged_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"shipping_tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"prepaid_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"credit_applied_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"shipping_prepaid_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"shipping_credit_applied_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cod_expected_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cod_due_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"cod_collected_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"remitted_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"delivered_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"returned_credit_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"exchange_consumed_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"payment_method" "order_payment_method" NOT NULL,
	"prepaid_method" "order_payment_method",
	"source_captured_from" "order_source_captured_from" DEFAULT 'none' NOT NULL,
	"source_campaign_id" text,
	"source_adset_id" text,
	"source_ad_id" text,
	"source_utm_source" text,
	"source_utm_medium" text,
	"source_utm_campaign" text,
	"source_utm_content" text,
	"source_landing_page" text,
	"source_referrer" text,
	"discount_code" text,
	"source_media_buyer_id" uuid,
	"source_influencer_code" text,
	"ship_to_name" text,
	"ship_to_phone" text,
	"ship_to_phone_alt" text,
	"contact_phone_raw" text,
	"ship_to_address" text,
	"ship_to_area_list" text,
	"ship_to_governorate_code" text,
	"ship_to_city_code" text,
	"ship_to_zone_code" text,
	"courier_note" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason_code" text,
	"refused_reason_code" text,
	"carrier_delivery_created_at" timestamp with time zone,
	"gift_reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_store_number_unique" UNIQUE("tenant_id","store_id","order_number"),
	CONSTRAINT "orders_replacement_has_original" CHECK (("orders"."type" = 'exchange_replacement') = ("orders"."original_order_id" IS NOT NULL)),
	CONSTRAINT "orders_related_order_pair" CHECK (("orders"."related_order_id" IS NULL) = ("orders"."related_order_relation" IS NULL)),
	CONSTRAINT "orders_gifted_total_zero" CHECK ("orders"."type" <> 'gifted' OR ("orders"."total_amount" = 0 AND "orders"."lines_gross_amount" = 0 AND "orders"."shipping_charged_amount" = 0 AND "orders"."gift_reason_code" IS NOT NULL)),
	CONSTRAINT "orders_amounts_not_negative" CHECK ("orders"."lines_gross_amount" >= 0 AND "orders"."shipping_charged_amount" >= 0 AND "orders"."shipping_tax_amount" >= 0
        AND "orders"."total_amount" >= 0 AND "orders"."prepaid_amount" >= 0 AND "orders"."credit_applied_amount" >= 0
        AND "orders"."shipping_prepaid_amount" >= 0 AND "orders"."shipping_credit_applied_amount" >= 0
        AND "orders"."cod_expected_amount" >= 0 AND "orders"."cod_due_amount" >= 0 AND "orders"."cod_collected_amount" >= 0
        AND "orders"."remitted_amount" >= 0 AND "orders"."delivered_amount" >= 0
        AND "orders"."returned_credit_amount" >= 0 AND "orders"."exchange_consumed_amount" >= 0),
	CONSTRAINT "orders_cod_expected" CHECK ("orders"."cod_expected_amount" = "orders"."total_amount" - "orders"."prepaid_amount" - "orders"."credit_applied_amount"),
	CONSTRAINT "orders_shipping_shares_within_charge" CHECK ("orders"."shipping_prepaid_amount" + "orders"."shipping_credit_applied_amount" <= "orders"."shipping_charged_amount"),
	CONSTRAINT "orders_refused_has_reason" CHECK ("orders"."fulfillment_state" <> 'refused' OR "orders"."refused_reason_code" IS NOT NULL),
	CONSTRAINT "orders_prepaid_method_when_prepaid" CHECK (("orders"."prepaid_amount" = 0) = ("orders"."prepaid_method" IS NULL)),
	CONSTRAINT "orders_total_is_lines_plus_shipping" CHECK ("orders"."total_amount" = "orders"."lines_gross_amount" + "orders"."shipping_charged_amount"),
	CONSTRAINT "orders_ship_to_phone_e164" CHECK ("orders"."ship_to_phone" IS NULL OR "orders"."ship_to_phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "orders_ship_to_phone_alt_e164" CHECK ("orders"."ship_to_phone_alt" IS NULL OR "orders"."ship_to_phone_alt" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "orders_contact_phone_raw_length" CHECK ("orders"."contact_phone_raw" IS NULL OR length("orders"."contact_phone_raw") <= 64),
	CONSTRAINT "orders_cancelled_has_reason" CHECK ("orders"."fulfillment_state" <> 'cancelled' OR "orders"."cancel_reason_code" IS NOT NULL),
	CONSTRAINT "orders_refused_reason_known" CHECK ("orders"."refused_reason_code" IS NULL OR "orders"."refused_reason_code" IN ('size', 'changed_mind', 'price', 'not_ordered', 'damaged', 'other')),
	CONSTRAINT "orders_cancel_reason_code_shape" CHECK ("orders"."cancel_reason_code" IS NULL OR "orders"."cancel_reason_code" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "orders_refused_reason_code_shape" CHECK ("orders"."refused_reason_code" IS NULL OR "orders"."refused_reason_code" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "orders_gift_reason_code_shape" CHECK ("orders"."gift_reason_code" IS NULL OR "orders"."gift_reason_code" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"name_ar" text,
	"tax_id" text,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"is_consignment_partner" boolean DEFAULT false NOT NULL,
	"is_wholesale_customer" boolean DEFAULT false NOT NULL,
	"is_factory" boolean DEFAULT false NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "parties_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "parties_has_a_role" CHECK ("parties"."is_supplier" OR "parties"."is_factory" OR "parties"."is_consignment_partner" OR "parties"."is_wholesale_customer")
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"entity" text NOT NULL,
	"key" text NOT NULL,
	"type" "custom_field_type" NOT NULL,
	"label" jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"options" jsonb,
	"archived_at" timestamp with time zone,
	CONSTRAINT "custom_field_definitions_entity_key_unique" UNIQUE("tenant_id","entity","key")
);
--> statement-breakpoint
CREATE TABLE "document_counters" (
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"doc_type" text NOT NULL,
	"year" integer NOT NULL,
	"last_value" integer NOT NULL,
	CONSTRAINT "document_counters_tenant_id_doc_type_year_pk" PRIMARY KEY("tenant_id","doc_type","year")
);
--> statement-breakpoint
CREATE TABLE "install" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_cost_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"kind" "order_cost_rule_kind" NOT NULL,
	"status" "order_cost_rule_status" NOT NULL,
	"value" numeric(14, 4),
	"effective_from" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	CONSTRAINT "order_cost_rules_value_when_set" CHECK (("order_cost_rules"."status" = 'set') = ("order_cost_rules"."value" IS NOT NULL)),
	CONSTRAINT "order_cost_rules_value_not_negative" CHECK ("order_cost_rules"."value" >= 0),
	CONSTRAINT "order_cost_rules_percent_at_most_100" CHECK ("order_cost_rules"."kind" = 'packaging_per_order' OR "order_cost_rules"."value" <= 100)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "settings_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "settlement_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"owner_type" "settlement_owner_type" NOT NULL,
	"owner_connection_id" uuid,
	"owner_party_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_accounts_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "settlement_accounts_owner_matches_type" CHECK (CASE "settlement_accounts"."owner_type"
            WHEN 'consignment_partner' THEN "settlement_accounts"."owner_party_id" IS NOT NULL AND "settlement_accounts"."owner_connection_id" IS NULL
            ELSE "settlement_accounts"."owner_connection_id" IS NOT NULL AND "settlement_accounts"."owner_party_id" IS NULL
          END)
);
--> statement-breakpoint
CREATE TABLE "settlement_line_matches" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"result" "settlement_match_result" NOT NULL,
	"order_id" uuid,
	"order_line_id" uuid,
	"variant_id" uuid,
	"account_code" text,
	"refund_id" uuid,
	"payment_reference" text,
	"reason_code" text,
	"matched_by_type" "settlement_matched_by_type" NOT NULL,
	"matched_by" uuid,
	"rule_code" text,
	"supersedes_match_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_line_matches_id_line_unique" UNIQUE("id","line_id"),
	CONSTRAINT "settlement_line_matches_supersedes_unique" UNIQUE("supersedes_match_id"),
	CONSTRAINT "settlement_line_matches_line_needs_order" CHECK ("settlement_line_matches"."order_line_id" IS NULL OR "settlement_line_matches"."order_id" IS NOT NULL),
	CONSTRAINT "settlement_line_matches_matched_has_target" CHECK ("settlement_line_matches"."result" <> 'matched' OR "settlement_line_matches"."order_id" IS NOT NULL OR "settlement_line_matches"."variant_id" IS NOT NULL),
	CONSTRAINT "settlement_line_matches_account_code_when_accounted" CHECK (("settlement_line_matches"."result" = 'accounted') = ("settlement_line_matches"."account_code" IS NOT NULL)),
	CONSTRAINT "settlement_line_matches_reason_when_unmatched" CHECK ("settlement_line_matches"."result" NOT IN ('unmatched', 'cleared') OR "settlement_line_matches"."reason_code" IS NOT NULL),
	CONSTRAINT "settlement_line_matches_person_has_actor" CHECK ("settlement_line_matches"."matched_by_type" <> 'person' OR "settlement_line_matches"."matched_by" IS NOT NULL),
	CONSTRAINT "settlement_line_matches_reason_code_shape" CHECK ("settlement_line_matches"."reason_code" IS NULL OR "settlement_line_matches"."reason_code" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "settlement_line_matches_account_code_shape" CHECK ("settlement_line_matches"."account_code" IS NULL OR "settlement_line_matches"."account_code" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "settlement_line_matches_rule_code_shape" CHECK ("settlement_line_matches"."rule_code" IS NULL OR "settlement_line_matches"."rule_code" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "settlement_line_matches_payment_reference_length" CHECK (char_length("settlement_line_matches"."payment_reference") <= 500)
);
--> statement-breakpoint
CREATE TABLE "settlement_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_kind" "settlement_line_kind" NOT NULL,
	"fee_code" text,
	"amount" numeric(14, 2) NOT NULL,
	"external_line_ref" text NOT NULL,
	"occurred_on" date NOT NULL,
	"tracking_number" text,
	"business_reference" text,
	"store_id" uuid,
	"partner_code" text,
	"partner_text" text,
	"partner_order_ref" text,
	"quantity" integer,
	"unit_price" numeric(14, 2),
	"gross_amount" numeric(14, 2),
	"discount_amount" numeric(14, 2),
	"net_amount" numeric(14, 2),
	"amounts_include_vat" boolean,
	CONSTRAINT "settlement_lines_statement_ref_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","account_id","statement_id","external_line_ref","fee_code"),
	CONSTRAINT "settlement_lines_other_fee_has_code" CHECK ("settlement_lines"."line_kind" <> 'other_fee' OR "settlement_lines"."fee_code" IS NOT NULL),
	CONSTRAINT "settlement_lines_fee_code_only_on_other_fee" CHECK ("settlement_lines"."line_kind" = 'other_fee' OR "settlement_lines"."fee_code" IS NULL),
	CONSTRAINT "settlement_lines_partner_text_length" CHECK (char_length("settlement_lines"."partner_text") <= 500)
);
--> statement-breakpoint
CREATE TABLE "settlement_period_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"action" "settlement_period_action" NOT NULL,
	"evidence" jsonb,
	"reason" text,
	"actor_type" "settlement_period_actor_type" NOT NULL,
	"actor_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_period_events_revoke_has_reason" CHECK ("settlement_period_events"."action" <> 'revoked' OR ("settlement_period_events"."reason" IS NOT NULL AND btrim("settlement_period_events"."reason") <> '')),
	CONSTRAINT "settlement_period_events_close_has_evidence" CHECK ("settlement_period_events"."action" <> 'closed' OR "settlement_period_events"."evidence" IS NOT NULL),
	CONSTRAINT "settlement_period_events_person_has_actor" CHECK ("settlement_period_events"."actor_type" <> 'person' OR "settlement_period_events"."actor_id" IS NOT NULL),
	CONSTRAINT "settlement_period_events_reason_shape" CHECK ("settlement_period_events"."reason" IS NULL OR "settlement_period_events"."reason" ~ '^[a-z][a-z0-9_.]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "settlement_periods" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "settlement_period_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_periods_dates_in_order" CHECK ("settlement_periods"."starts_on" <= "settlement_periods"."ends_on")
);
--> statement-breakpoint
CREATE TABLE "settlement_statements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "settlement_statement_kind" NOT NULL,
	"external_reference" text NOT NULL,
	"covers_from" date,
	"covers_to" date,
	"object_key" text,
	"sha256" text,
	"statement_total" numeric(14, 2),
	"statement_units" integer,
	"deposited_amount" numeric(14, 2),
	"deposited_on" date,
	"supersedes_statement_id" uuid,
	"imported_by" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_statements_reference_unique" UNIQUE NULLS NOT DISTINCT("tenant_id","account_id","external_reference","sha256"),
	CONSTRAINT "settlement_statements_supersedes_unique" UNIQUE("supersedes_statement_id"),
	CONSTRAINT "settlement_statements_id_account_unique" UNIQUE("id","account_id"),
	CONSTRAINT "settlement_statements_not_superseding_self" CHECK ("settlement_statements"."supersedes_statement_id" IS DISTINCT FROM "settlement_statements"."id"),
	CONSTRAINT "settlement_statements_covers_in_order" CHECK ("settlement_statements"."covers_from" IS NULL OR "settlement_statements"."covers_to" IS NULL OR "settlement_statements"."covers_from" <= "settlement_statements"."covers_to")
);
--> statement-breakpoint
CREATE TABLE "stock_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"uom_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	CONSTRAINT "stock_receipt_lines_receipt_variant_unique" UNIQUE("receipt_id","variant_id"),
	CONSTRAINT "stock_receipt_lines_receipt_position_unique" UNIQUE("tenant_id","receipt_id","position"),
	CONSTRAINT "stock_receipt_lines_position_range" CHECK ("stock_receipt_lines"."position" BETWEEN 1 AND 200),
	CONSTRAINT "stock_receipt_lines_quantity_range" CHECK ("stock_receipt_lines"."quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "stock_receipt_lines_unit_cost_not_negative" CHECK ("stock_receipt_lines"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"request_hash" text NOT NULL,
	"number" text NOT NULL,
	"location_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"reference" text,
	"note" text,
	"status" "stock_receipt_status" DEFAULT 'posted' NOT NULL,
	"movement_group_id" uuid NOT NULL,
	"posted_by" uuid NOT NULL,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	"void_reason" text,
	"void_group_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_receipts_movement_group_id_unique" UNIQUE("movement_group_id"),
	CONSTRAINT "stock_receipts_void_group_id_unique" UNIQUE("void_group_id"),
	CONSTRAINT "stock_receipts_number_unique" UNIQUE("tenant_id","number"),
	CONSTRAINT "stock_receipts_reference_length" CHECK ("stock_receipts"."reference" IS NULL OR char_length("stock_receipts"."reference") BETWEEN 1 AND 64),
	CONSTRAINT "stock_receipts_note_length" CHECK ("stock_receipts"."note" IS NULL OR char_length("stock_receipts"."note") BETWEEN 1 AND 500),
	CONSTRAINT "stock_receipts_void_reason_length" CHECK ("stock_receipts"."void_reason" IS NULL OR char_length("stock_receipts"."void_reason") BETWEEN 1 AND 500),
	CONSTRAINT "stock_receipts_voided_fields" CHECK (num_nonnulls("stock_receipts"."voided_at", "stock_receipts"."voided_by", "stock_receipts"."void_reason", "stock_receipts"."void_group_id") = CASE WHEN "stock_receipts"."status" = 'voided' THEN 4 ELSE 0 END)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"type" text NOT NULL,
	"linked_type" "task_linked_type" NOT NULL,
	"linked_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"owner_hat" text,
	"due_at" timestamp with time zone,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"outcome_code" text,
	"note" text,
	"dedupe_key" text,
	"created_by_type" "task_created_by_type" NOT NULL,
	"created_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operating_day" date NOT NULL,
	CONSTRAINT "tasks_owner_hat_internal" CHECK ("tasks"."owner_hat" IS NULL OR "tasks"."owner_hat" IN ('support', 'operations', 'warehouse', 'manager')),
	CONSTRAINT "tasks_has_owner" CHECK ("tasks"."owner_user_id" IS NOT NULL OR "tasks"."owner_hat" IS NOT NULL),
	CONSTRAINT "tasks_outcome_when_done" CHECK (("tasks"."status" = 'done') = ("tasks"."outcome_code" IS NOT NULL)),
	CONSTRAINT "tasks_closed_at_when_closed" CHECK (("tasks"."status" = 'open') = ("tasks"."closed_at" IS NULL)),
	CONSTRAINT "tasks_closed_by_when_closed" CHECK ("tasks"."closed_by" IS NULL OR "tasks"."status" <> 'open'),
	CONSTRAINT "tasks_person_has_creator" CHECK ("tasks"."created_by_type" <> 'person' OR "tasks"."created_by" IS NOT NULL),
	CONSTRAINT "tasks_type_shape" CHECK ("tasks"."type" IS NULL OR "tasks"."type" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "tasks_outcome_code_shape" CHECK ("tasks"."outcome_code" IS NULL OR "tasks"."outcome_code" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "tasks_dedupe_key_shape" CHECK ("tasks"."dedupe_key" IS NULL OR "tasks"."dedupe_key" ~ '^[A-Za-z0-9:_.-]{1,200}$')
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_variant_id_product_id_product_variants_id_product_id_fk" FOREIGN KEY ("variant_id","product_id") REFERENCES "public"."product_variants"("id","product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_base_uom_id_uoms_id_fk" FOREIGN KEY ("base_uom_id") REFERENCES "public"."uoms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_product_group_id_product_groups_id_fk" FOREIGN KEY ("product_group_id") REFERENCES "public"."product_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_uom_conversions" ADD CONSTRAINT "variant_uom_conversions_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_uom_conversions" ADD CONSTRAINT "variant_uom_conversions_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_default_store_id_stores_id_fk" FOREIGN KEY ("default_store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_commands" ADD CONSTRAINT "outbound_commands_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_commands" ADD CONSTRAINT "outbound_commands_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_reverses_entry_id_customer_id_credit_entries_id_customer_id_fk" FOREIGN KEY ("reverses_entry_id","customer_id") REFERENCES "public"."credit_entries"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_entries" ADD CONSTRAINT "credit_entries_order_line_id_order_id_order_lines_id_order_id_fk" FOREIGN KEY ("order_line_id","order_id") REFERENCES "public"."order_lines"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_external_ids" ADD CONSTRAINT "customer_external_ids_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_external_ids" ADD CONSTRAINT "customer_external_ids_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_external_ids" ADD CONSTRAINT "customer_external_ids_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merges" ADD CONSTRAINT "customer_merges_survivor_id_customers_id_fk" FOREIGN KEY ("survivor_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merges" ADD CONSTRAINT "customer_merges_merged_id_customers_id_fk" FOREIGN KEY ("merged_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merges" ADD CONSTRAINT "customer_merges_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merges" ADD CONSTRAINT "customer_merges_undoes_merge_id_customer_merges_id_fk" FOREIGN KEY ("undoes_merge_id") REFERENCES "public"."customer_merges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_phones" ADD CONSTRAINT "customer_phones_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merged_into_id_customers_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_groups" ADD CONSTRAINT "movement_groups_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_groups" ADD CONSTRAINT "movement_groups_reverses_group_id_movement_groups_id_fk" FOREIGN KEY ("reverses_group_id") REFERENCES "public"."movement_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_serials" ADD CONSTRAINT "movement_serials_movement_id_stock_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_serials" ADD CONSTRAINT "movement_serials_serial_id_serials_id_fk" FOREIGN KEY ("serial_id") REFERENCES "public"."serials"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_lot_id_variant_id_lots_id_variant_id_fk" FOREIGN KEY ("lot_id","variant_id") REFERENCES "public"."lots"("id","variant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_lot_id_variant_id_lots_id_variant_id_fk" FOREIGN KEY ("lot_id","variant_id") REFERENCES "public"."lots"("id","variant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serials" ADD CONSTRAINT "serials_bin_id_location_id_bins_id_location_id_fk" FOREIGN KEY ("bin_id","location_id") REFERENCES "public"."bins"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_level_discrepancies" ADD CONSTRAINT "stock_level_discrepancies_stock_level_id_stock_levels_id_fk" FOREIGN KEY ("stock_level_id") REFERENCES "public"."stock_levels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_bin_id_location_id_bins_id_location_id_fk" FOREIGN KEY ("bin_id","location_id") REFERENCES "public"."bins"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_levels" ADD CONSTRAINT "stock_levels_lot_id_variant_id_lots_id_variant_id_fk" FOREIGN KEY ("lot_id","variant_id") REFERENCES "public"."lots"("id","variant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_group_id_movement_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."movement_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_bin_id_location_id_bins_id_location_id_fk" FOREIGN KEY ("bin_id","location_id") REFERENCES "public"."bins"("id","location_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_variant_id_lots_id_variant_id_fk" FOREIGN KEY ("lot_id","variant_id") REFERENCES "public"."lots"("id","variant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bins" ADD CONSTRAINT "bins_parent_id_bins_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."bins"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_owner_policies" ADD CONSTRAINT "location_owner_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_split_from_line_id_order_lines_id_fk" FOREIGN KEY ("split_from_line_id") REFERENCES "public"."order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_media_buyer_id_users_id_fk" FOREIGN KEY ("source_media_buyer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_original_order_id_orders_id_fk" FOREIGN KEY ("original_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_related_order_id_orders_id_fk" FOREIGN KEY ("related_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_cost_rules" ADD CONSTRAINT "order_cost_rules_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_accounts" ADD CONSTRAINT "settlement_accounts_owner_connection_id_connections_id_fk" FOREIGN KEY ("owner_connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_accounts" ADD CONSTRAINT "settlement_accounts_owner_party_id_parties_id_fk" FOREIGN KEY ("owner_party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_line_id_settlement_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."settlement_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_supersedes_match_id_line_id_settlement_line_matches_id_line_id_fk" FOREIGN KEY ("supersedes_match_id","line_id") REFERENCES "public"."settlement_line_matches"("id","line_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_line_matches" ADD CONSTRAINT "settlement_line_matches_order_line_id_order_id_order_lines_id_order_id_fk" FOREIGN KEY ("order_line_id","order_id") REFERENCES "public"."order_lines"("id","order_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_account_id_settlement_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."settlement_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_statement_id_account_id_settlement_statements_id_account_id_fk" FOREIGN KEY ("statement_id","account_id") REFERENCES "public"."settlement_statements"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_period_events" ADD CONSTRAINT "settlement_period_events_period_id_settlement_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."settlement_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_period_events" ADD CONSTRAINT "settlement_period_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_periods" ADD CONSTRAINT "settlement_periods_account_id_settlement_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."settlement_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_account_id_settlement_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."settlement_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_statements" ADD CONSTRAINT "settlement_statements_supersedes_statement_id_account_id_settlement_statements_id_account_id_fk" FOREIGN KEY ("supersedes_statement_id","account_id") REFERENCES "public"."settlement_statements"("id","account_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_receipt_id_stock_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."stock_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_movement_group_id_movement_groups_id_fk" FOREIGN KEY ("movement_group_id") REFERENCES "public"."movement_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_void_group_id_movement_groups_id_fk" FOREIGN KEY ("void_group_id") REFERENCES "public"."movement_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_unique" ON "accounts" USING btree ("tenant_id","provider_id","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_key_unique" ON "rate_limits" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sign_in_slots_email_ip_idx" ON "sign_in_slots" USING btree ("email_key","ip");--> statement-breakpoint
CREATE UNIQUE INDEX "two_factors_user_unique" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("tenant_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_staff_code_unique" ON "users" USING btree ("tenant_id","staff_code") WHERE "users"."staff_code" is not null;--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier","expires_at");--> statement-breakpoint
CREATE INDEX "barcodes_variant_idx" ON "barcodes" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "barcodes_uom_idx" ON "barcodes" USING btree ("uom_id");--> statement-breakpoint
CREATE INDEX "cost_records_style_idx" ON "cost_records" USING btree ("product_id","effective_from" DESC NULLS FIRST,"recorded_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "cost_records_variant_idx" ON "cost_records" USING btree ("variant_id","effective_from" DESC NULLS FIRST,"recorded_at" DESC NULLS FIRST) WHERE "cost_records"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cost_records_season_idx" ON "cost_records" USING btree ("season_id");--> statement-breakpoint
CREATE INDEX "cost_records_variant_product_idx" ON "cost_records" USING btree ("variant_id","product_id") WHERE "cost_records"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "cost_records_recorded_by_idx" ON "cost_records" USING btree ("recorded_by");--> statement-breakpoint
CREATE INDEX "product_options_product_idx" ON "product_options" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_variants_base_uom_idx" ON "product_variants" USING btree ("base_uom_id");--> statement-breakpoint
CREATE INDEX "product_variants_sku_c_idx" ON "product_variants" USING btree ("sku" COLLATE "C");--> statement-breakpoint
CREATE INDEX "product_variants_sku_trgm_idx" ON "product_variants" USING gin ("sku" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "products_product_group_idx" ON "products" USING btree ("product_group_id");--> statement-breakpoint
CREATE INDEX "products_season_idx" ON "products" USING btree ("season_id");--> statement-breakpoint
CREATE INDEX "products_tags_idx" ON "products" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "products_search_trgm_idx" ON "products" USING gin ((coalesce("name"->>'en', '') || ' ' || coalesce("name"->>'ar', '') || ' ' || "style_code") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "variant_uom_conversions_uom_idx" ON "variant_uom_conversions" USING btree ("uom_id");--> statement-breakpoint
CREATE INDEX "channels_location_idx" ON "channels" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "channels_default_store_idx" ON "channels" USING btree ("default_store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_shopify_store_unique" ON "connections" USING btree ("tenant_id","store_id") WHERE "connections"."provider" = 'shopify';--> statement-breakpoint
CREATE INDEX "connections_store_idx" ON "connections" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "outbound_commands_open_linked_idx" ON "outbound_commands" USING btree ("linked_type","linked_id") WHERE "outbound_commands"."sync_state" IN ('waiting', 'failed');--> statement-breakpoint
CREATE INDEX "outbound_commands_connection_idx" ON "outbound_commands" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "outbound_commands_resolved_by_idx" ON "outbound_commands" USING btree ("resolved_by");--> statement-breakpoint
CREATE INDEX "credit_entries_customer_funding_idx" ON "credit_entries" USING btree ("customer_id","funding","recorded_at");--> statement-breakpoint
CREATE INDEX "credit_entries_posting_idx" ON "credit_entries" USING btree ("posting_id");--> statement-breakpoint
CREATE INDEX "credit_entries_order_idx" ON "credit_entries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "credit_entries_order_line_idx" ON "credit_entries" USING btree ("order_line_id","order_id") WHERE "credit_entries"."order_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "credit_entries_reverses_entry_customer_idx" ON "credit_entries" USING btree ("reverses_entry_id","customer_id") WHERE "credit_entries"."reverses_entry_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "credit_entries_exchange_idx" ON "credit_entries" USING btree ("exchange_id");--> statement-breakpoint
CREATE INDEX "credit_entries_refund_idx" ON "credit_entries" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "credit_entries_actor_idx" ON "credit_entries" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "credit_entries_operating_day_idx" ON "credit_entries" USING btree ("operating_day");--> statement-breakpoint
CREATE INDEX "customer_external_ids_customer_idx" ON "customer_external_ids" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_external_ids_connection_idx" ON "customer_external_ids" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "customer_external_ids_channel_idx" ON "customer_external_ids" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "customer_merges_survivor_idx" ON "customer_merges" USING btree ("survivor_id");--> statement-breakpoint
CREATE INDEX "customer_merges_merged_idx" ON "customer_merges" USING btree ("merged_id");--> statement-breakpoint
CREATE INDEX "customer_merges_actor_idx" ON "customer_merges" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "customer_phones_customer_idx" ON "customer_phones" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_phones_one_primary_unique" ON "customer_phones" USING btree ("customer_id") WHERE "customer_phones"."is_primary";--> statement-breakpoint
CREATE INDEX "customers_merged_into_idx" ON "customers" USING btree ("merged_into_id") WHERE "customers"."merged_into_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "lots_variant_idx" ON "lots" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "movement_groups_source_idx" ON "movement_groups" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "movement_groups_operating_day_idx" ON "movement_groups" USING btree ("operating_day");--> statement-breakpoint
CREATE INDEX "movement_groups_posted_by_idx" ON "movement_groups" USING btree ("posted_by");--> statement-breakpoint
CREATE INDEX "movement_serials_serial_idx" ON "movement_serials" USING btree ("serial_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_active_source_line_unique" ON "reservations" USING btree ("tenant_id","source_type","source_line_id") WHERE "reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "reservations_active_balance_idx" ON "reservations" USING btree ("variant_id","location_id","lot_id") WHERE "reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "reservations_lot_idx" ON "reservations" USING btree ("lot_id","variant_id") WHERE "reservations"."lot_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "reservations_variant_idx" ON "reservations" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "reservations_location_idx" ON "reservations" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "serials_place_idx" ON "serials" USING btree ("variant_id","location_id","bin_id") WHERE "serials"."status" = 'in_stock';--> statement-breakpoint
CREATE INDEX "serials_bin_idx" ON "serials" USING btree ("bin_id","location_id") WHERE "serials"."bin_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "serials_lot_idx" ON "serials" USING btree ("lot_id","variant_id") WHERE "serials"."lot_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "serials_location_idx" ON "serials" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "serials_variant_idx" ON "serials" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_level_discrepancies_stock_level_idx" ON "stock_level_discrepancies" USING btree ("stock_level_id");--> statement-breakpoint
CREATE INDEX "stock_levels_location_variant_idx" ON "stock_levels" USING btree ("location_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_levels_bin_idx" ON "stock_levels" USING btree ("bin_id","location_id") WHERE "stock_levels"."bin_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_levels_lot_idx" ON "stock_levels" USING btree ("lot_id","variant_id") WHERE "stock_levels"."lot_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_levels_updated_idx" ON "stock_levels" USING btree ("updated_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "stock_movements_variant_location_effective_idx" ON "stock_movements" USING btree ("variant_id","location_id","effective_at");--> statement-breakpoint
CREATE INDEX "stock_movements_group_idx" ON "stock_movements" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "stock_movements_operating_day_idx" ON "stock_movements" USING btree ("operating_day");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_recorded_idx" ON "stock_movements" USING btree ("variant_id","recorded_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "stock_movements_recorded_brin" ON "stock_movements" USING brin ("recorded_at");--> statement-breakpoint
CREATE INDEX "stock_movements_lot_idx" ON "stock_movements" USING btree ("lot_id","variant_id") WHERE "stock_movements"."lot_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_movements_bin_idx" ON "stock_movements" USING btree ("bin_id","location_id") WHERE "stock_movements"."bin_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_movements_location_idx" ON "stock_movements" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "bins_parent_idx" ON "bins" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "bins_location_idx" ON "bins" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "location_owner_policies_updated_by_idx" ON "location_owner_policies" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "locations_party_idx" ON "locations" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "order_events_order_recorded_idx" ON "order_events" USING btree ("order_id","recorded_at","id");--> statement-breakpoint
CREATE INDEX "order_events_day_machine_state_idx" ON "order_events" USING btree ("operating_day","machine","to_state");--> statement-breakpoint
CREATE INDEX "order_events_recorded_brin" ON "order_events" USING brin ("recorded_at");--> statement-breakpoint
CREATE INDEX "order_events_actor_idx" ON "order_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_lines_variant_idx" ON "order_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "order_lines_split_from_idx" ON "order_lines" USING btree ("split_from_line_id");--> statement-breakpoint
CREATE INDEX "orders_store_placed_idx" ON "orders" USING btree ("store_id","placed_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "orders_confirmation_queue_idx" ON "orders" USING btree ("placed_at","id") WHERE "orders"."fulfillment_state" = 'new';--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_operating_day_store_idx" ON "orders" USING btree ("operating_day","store_id");--> statement-breakpoint
CREATE INDEX "orders_original_order_idx" ON "orders" USING btree ("original_order_id");--> statement-breakpoint
CREATE INDEX "orders_related_order_idx" ON "orders" USING btree ("related_order_id");--> statement-breakpoint
CREATE INDEX "orders_open_cash_idx" ON "orders" USING btree ("cash_state") WHERE "orders"."cash_state" NOT IN ('reconciled', 'nothing_to_collect');--> statement-breakpoint
CREATE INDEX "orders_write_back_idx" ON "orders" USING btree ("write_back_state") WHERE "orders"."write_back_state" <> 'none';--> statement-breakpoint
CREATE INDEX "orders_discount_code_idx" ON "orders" USING btree ("discount_code") WHERE "orders"."discount_code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_channel_idx" ON "orders" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "orders_source_media_buyer_idx" ON "orders" USING btree ("source_media_buyer_id");--> statement-breakpoint
CREATE INDEX "orders_confirmed_by_idx" ON "orders" USING btree ("confirmed_by");--> statement-breakpoint
CREATE INDEX "order_cost_rules_kind_effective_idx" ON "order_cost_rules" USING btree ("kind","effective_from" DESC NULLS FIRST,"recorded_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "order_cost_rules_recorded_by_idx" ON "order_cost_rules" USING btree ("recorded_by");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_accounts_live_connection_unique" ON "settlement_accounts" USING btree ("tenant_id","owner_connection_id") WHERE "settlement_accounts"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_accounts_live_party_unique" ON "settlement_accounts" USING btree ("tenant_id","owner_party_id") WHERE "settlement_accounts"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "settlement_accounts_connection_idx" ON "settlement_accounts" USING btree ("owner_connection_id");--> statement-breakpoint
CREATE INDEX "settlement_accounts_party_idx" ON "settlement_accounts" USING btree ("owner_party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_line_matches_one_first_row_unique" ON "settlement_line_matches" USING btree ("line_id") WHERE "settlement_line_matches"."supersedes_match_id" IS NULL;--> statement-breakpoint
CREATE INDEX "settlement_line_matches_line_recorded_idx" ON "settlement_line_matches" USING btree ("line_id","recorded_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "settlement_line_matches_order_idx" ON "settlement_line_matches" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "settlement_line_matches_order_line_idx" ON "settlement_line_matches" USING btree ("order_line_id","order_id") WHERE "settlement_line_matches"."order_line_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "settlement_line_matches_supersedes_line_idx" ON "settlement_line_matches" USING btree ("supersedes_match_id","line_id") WHERE "settlement_line_matches"."supersedes_match_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "settlement_line_matches_variant_idx" ON "settlement_line_matches" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "settlement_line_matches_matched_by_idx" ON "settlement_line_matches" USING btree ("matched_by");--> statement-breakpoint
CREATE INDEX "settlement_line_matches_refund_idx" ON "settlement_line_matches" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_tracking_idx" ON "settlement_lines" USING btree ("tracking_number");--> statement-breakpoint
CREATE INDEX "settlement_lines_statement_idx" ON "settlement_lines" USING btree ("statement_id","account_id");--> statement-breakpoint
CREATE INDEX "settlement_lines_account_occurred_idx" ON "settlement_lines" USING btree ("account_id","occurred_on");--> statement-breakpoint
CREATE INDEX "settlement_lines_store_idx" ON "settlement_lines" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "settlement_period_events_period_recorded_idx" ON "settlement_period_events" USING btree ("period_id","recorded_at");--> statement-breakpoint
CREATE INDEX "settlement_period_events_actor_idx" ON "settlement_period_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "settlement_periods_account_starts_idx" ON "settlement_periods" USING btree ("account_id","starts_on" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "settlement_statements_account_received_idx" ON "settlement_statements" USING btree ("account_id","received_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "settlement_statements_account_covers_idx" ON "settlement_statements" USING btree ("account_id","covers_from","covers_to");--> statement-breakpoint
CREATE INDEX "settlement_statements_imported_by_idx" ON "settlement_statements" USING btree ("imported_by");--> statement-breakpoint
CREATE INDEX "settlement_statements_supersedes_account_idx" ON "settlement_statements" USING btree ("supersedes_statement_id","account_id") WHERE "settlement_statements"."supersedes_statement_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_receipt_lines_variant_idx" ON "stock_receipt_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_receipt_lines_uom_idx" ON "stock_receipt_lines" USING btree ("uom_id");--> statement-breakpoint
CREATE INDEX "stock_receipts_effective_idx" ON "stock_receipts" USING btree ("effective_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "stock_receipts_posted_by_idx" ON "stock_receipts" USING btree ("posted_by");--> statement-breakpoint
CREATE INDEX "stock_receipts_voided_by_idx" ON "stock_receipts" USING btree ("voided_by") WHERE "stock_receipts"."voided_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_receipts_location_effective_idx" ON "stock_receipts" USING btree ("location_id","effective_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_open_dedupe_key_unique" ON "tasks" USING btree ("tenant_id","dedupe_key") WHERE "tasks"."status" = 'open';--> statement-breakpoint
CREATE INDEX "tasks_open_owner_user_idx" ON "tasks" USING btree ("owner_user_id","due_at") WHERE "tasks"."status" = 'open';--> statement-breakpoint
CREATE INDEX "tasks_open_owner_hat_idx" ON "tasks" USING btree ("owner_hat","due_at") WHERE "tasks"."status" = 'open' AND "tasks"."owner_user_id" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_linked_idx" ON "tasks" USING btree ("linked_type","linked_id");--> statement-breakpoint
CREATE INDEX "tasks_operating_day_idx" ON "tasks" USING btree ("operating_day");--> statement-breakpoint
CREATE INDEX "tasks_owner_user_idx" ON "tasks" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "tasks_closed_by_idx" ON "tasks" USING btree ("closed_by");