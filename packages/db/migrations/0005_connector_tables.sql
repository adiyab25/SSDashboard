CREATE TYPE "public"."connection_health" AS ENUM('connecting', 'ok', 'degraded', 'failing');--> statement-breakpoint
CREATE TYPE "public"."external_entity" AS ENUM('product', 'variant', 'order');--> statement-breakpoint
CREATE TYPE "public"."inbound_source" AS ENUM('webhook', 'sweep', 'backfill', 'reconcile');--> statement-breakpoint
CREATE TYPE "public"."inbound_status" AS ENUM('received', 'processed', 'ignored', 'ignored_unlicensed', 'echo', 'failed');--> statement-breakpoint
CREATE TYPE "public"."inbound_subject" AS ENUM('order', 'product', 'customer', 'inventory_level', 'app', 'bulk_operation');--> statement-breakpoint
CREATE TYPE "public"."sync_run_kind" AS ENUM('connect', 'gateway_scan', 'backfill_products', 'backfill_orders', 'sweep_orders', 'sweep_products', 'hourly_check', 'stock_preview', 'stock_push', 'stock_reconcile');--> statement-breakpoint
CREATE TYPE "public"."sync_run_status" AS ENUM('running', 'succeeded', 'partial', 'failed');--> statement-breakpoint
ALTER TYPE "public"."outbound_linked_type" ADD VALUE 'connection';--> statement-breakpoint
CREATE TABLE "connection_external_ids" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"entity" "external_entity" NOT NULL,
	"external_id" text NOT NULL,
	"local_id" uuid,
	"external_version" timestamp with time zone,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_external_ids_unique" UNIQUE("tenant_id","connection_id","entity","external_id")
);
--> statement-breakpoint
CREATE TABLE "connection_stock_levels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"inventory_item_id" text NOT NULL,
	"target_quantity" integer,
	"pushed_quantity" integer,
	"pushed_at" timestamp with time zone,
	"push_command_id" uuid,
	"push_error_code" text,
	"shopify_quantity" integer,
	"shopify_seen_at" timestamp with time zone,
	"difference_shopify_quantity" integer,
	"difference_target_quantity" integer,
	"difference_seen_at" timestamp with time zone,
	"held_lower" boolean DEFAULT false NOT NULL,
	"difference_acknowledged_at" timestamp with time zone,
	"difference_acknowledged_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_stock_levels_connection_variant_unique" UNIQUE("connection_id","variant_id"),
	CONSTRAINT "connection_stock_levels_difference_together" CHECK (("connection_stock_levels"."difference_seen_at" IS NULL) = ("connection_stock_levels"."difference_shopify_quantity" IS NULL) AND ("connection_stock_levels"."difference_seen_at" IS NULL) = ("connection_stock_levels"."difference_target_quantity" IS NULL)),
	CONSTRAINT "connection_stock_levels_acknowledged_together" CHECK (("connection_stock_levels"."difference_acknowledged_at" IS NULL) = ("connection_stock_levels"."difference_acknowledged_by" IS NULL)),
	CONSTRAINT "connection_stock_levels_held_lower_is_lower" CHECK (NOT "connection_stock_levels"."held_lower" OR ("connection_stock_levels"."difference_shopify_quantity" IS NOT NULL AND "connection_stock_levels"."difference_target_quantity" IS NOT NULL AND "connection_stock_levels"."difference_shopify_quantity" < "connection_stock_levels"."difference_target_quantity")),
	CONSTRAINT "connection_stock_levels_push_error_code_shape" CHECK ("connection_stock_levels"."push_error_code" IS NULL OR "connection_stock_levels"."push_error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "connection_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" "sync_run_kind" NOT NULL,
	"status" "sync_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"watermark_from" timestamp with time zone,
	"watermark_to" timestamp with time zone,
	"cursor" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost_points" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	CONSTRAINT "connection_sync_runs_cost_not_negative" CHECK ("connection_sync_runs"."cost_points" >= 0),
	CONSTRAINT "connection_sync_runs_error_code_shape" CHECK ("connection_sync_runs"."error_code" IS NULL OR "connection_sync_runs"."error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"source" "inbound_source" NOT NULL,
	"topic" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"subject_type" "inbound_subject" NOT NULL,
	"subject_external_id" text,
	"subject_label" text,
	"subject_version" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "inbound_status" DEFAULT 'received' NOT NULL,
	"outcome" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "inbound_events_dedupe_unique" UNIQUE("tenant_id","connection_id","dedupe_key"),
	CONSTRAINT "inbound_events_attempts_not_negative" CHECK ("inbound_events"."attempts" >= 0),
	CONSTRAINT "inbound_events_topic_length" CHECK (char_length("inbound_events"."topic") <= 64),
	CONSTRAINT "inbound_events_dedupe_key_length" CHECK (char_length("inbound_events"."dedupe_key") <= 128),
	CONSTRAINT "inbound_events_subject_label_length" CHECK ("inbound_events"."subject_label" IS NULL OR char_length("inbound_events"."subject_label") <= 64),
	CONSTRAINT "inbound_events_outcome_shape" CHECK ("inbound_events"."outcome" IS NULL OR "inbound_events"."outcome" ~ '^[a-z][a-z0-9_.]{0,63}$'),
	CONSTRAINT "inbound_events_failure_code_shape" CHECK ("inbound_events"."failure_code" IS NULL OR "inbound_events"."failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
DROP INDEX "outbound_commands_connection_idx";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "shop_domain" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credentials_ciphertext" "bytea";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credentials_key_version" smallint;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credentials_hint" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "credentials_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "health" "connection_health" DEFAULT 'connecting' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "health_reason" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "health_warnings" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "health_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "api_version" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "go_live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "orders_swept_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "products_swept_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "stock_pushed_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "stock_push_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "stock_push_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "stock_push_preview_run_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_inbound_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_order_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_sweep_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "hook_auth_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "last_hook_auth_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbound_commands" ADD COLUMN "provider_ref" text;--> statement-breakpoint
ALTER TABLE "outbound_commands" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection_external_ids" ADD CONSTRAINT "connection_external_ids_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_stock_levels" ADD CONSTRAINT "connection_stock_levels_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_stock_levels" ADD CONSTRAINT "connection_stock_levels_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_stock_levels" ADD CONSTRAINT "connection_stock_levels_push_command_id_outbound_commands_id_fk" FOREIGN KEY ("push_command_id") REFERENCES "public"."outbound_commands"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_stock_levels" ADD CONSTRAINT "connection_stock_levels_difference_acknowledged_by_users_id_fk" FOREIGN KEY ("difference_acknowledged_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_sync_runs" ADD CONSTRAINT "connection_sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_external_ids_connection_idx" ON "connection_external_ids" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "connection_external_ids_local_idx" ON "connection_external_ids" USING btree ("entity","local_id") WHERE "connection_external_ids"."local_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "connection_external_ids_unmapped_variants_idx" ON "connection_external_ids" USING btree ("connection_id","entity") WHERE "connection_external_ids"."entity" = 'variant' AND coalesce("connection_external_ids"."state"->>'lastOutcome', '') NOT IN ('created', 'linked', 'updated', 'unchanged');--> statement-breakpoint
CREATE INDEX "connection_external_ids_waiting_orders_idx" ON "connection_external_ids" USING btree ("connection_id") WHERE "connection_external_ids"."entity" = 'order' AND ("connection_external_ids"."state" ? 'unmappedLines' OR "connection_external_ids"."state" ? 'pendingReplacementLines');--> statement-breakpoint
CREATE INDEX "connection_stock_levels_variant_idx" ON "connection_stock_levels" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "connection_stock_levels_push_command_idx" ON "connection_stock_levels" USING btree ("push_command_id") WHERE "connection_stock_levels"."push_command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "connection_stock_levels_acknowledged_by_idx" ON "connection_stock_levels" USING btree ("difference_acknowledged_by") WHERE "connection_stock_levels"."difference_acknowledged_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "connection_stock_levels_open_differences_idx" ON "connection_stock_levels" USING btree ("connection_id","difference_seen_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "connection_stock_levels"."difference_seen_at" IS NOT NULL AND "connection_stock_levels"."difference_acknowledged_at" IS NULL;--> statement-breakpoint
CREATE INDEX "connection_sync_runs_connection_kind_idx" ON "connection_sync_runs" USING btree ("connection_id","kind","started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "connection_sync_runs_started_brin" ON "connection_sync_runs" USING brin ("started_at");--> statement-breakpoint
CREATE INDEX "inbound_events_received_idx" ON "inbound_events" USING btree ("connection_id","subject_type","received_at") WHERE "inbound_events"."status" = 'received';--> statement-breakpoint
CREATE INDEX "inbound_events_subject_idx" ON "inbound_events" USING btree ("connection_id","subject_type","subject_external_id","received_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "inbound_events_failed_idx" ON "inbound_events" USING btree ("connection_id","received_at") WHERE "inbound_events"."status" = 'failed';--> statement-breakpoint
CREATE INDEX "inbound_events_received_at_brin" ON "inbound_events" USING brin ("received_at");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_stock_push_confirmed_by_users_id_fk" FOREIGN KEY ("stock_push_confirmed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_stock_push_preview_run_id_connection_sync_runs_id_fk" FOREIGN KEY ("stock_push_preview_run_id") REFERENCES "public"."connection_sync_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connections_shop_domain_unique" ON "connections" USING btree ("tenant_id","shop_domain") WHERE "connections"."shop_domain" IS NOT NULL AND "connections"."status" <> 'archived';--> statement-breakpoint
CREATE INDEX "connections_stock_push_confirmed_by_idx" ON "connections" USING btree ("stock_push_confirmed_by") WHERE "connections"."stock_push_confirmed_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "connections_stock_push_preview_run_idx" ON "connections" USING btree ("stock_push_preview_run_id") WHERE "connections"."stock_push_preview_run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "outbound_commands_connection_kind_idx" ON "outbound_commands" USING btree ("connection_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_shopify_needs_shop_domain" CHECK ("connections"."provider" <> 'shopify' OR "connections"."shop_domain" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_shop_domain_shape" CHECK ("connections"."shop_domain" IS NULL OR "connections"."shop_domain" ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$');--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credentials_key_version_together" CHECK (("connections"."credentials_ciphertext" IS NULL) = ("connections"."credentials_key_version" IS NULL));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_stock_push_confirmed_together" CHECK (("connections"."stock_push_confirmed_at" IS NULL) = ("connections"."stock_push_confirmed_by" IS NULL));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_health_reason_shape" CHECK ("connections"."health_reason" IS NULL OR "connections"."health_reason" ~ '^[A-Z][A-Z0-9_]{0,63}$');--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_config_no_secret_keys" CHECK (NOT ("connections"."config" ?| array['accessToken', 'clientSecret', 'secret', 'token']));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credentials_ciphertext_size" CHECK ("connections"."credentials_ciphertext" IS NULL OR octet_length("connections"."credentials_ciphertext") >= 29);--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credentials_key_version_positive" CHECK ("connections"."credentials_key_version" IS NULL OR "connections"."credentials_key_version" > 0);--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_credentials_hint_length" CHECK ("connections"."credentials_hint" IS NULL OR char_length("connections"."credentials_hint") <= 4);--> statement-breakpoint
ALTER TABLE "outbound_commands" ADD CONSTRAINT "outbound_commands_failure_reason_shape" CHECK ("outbound_commands"."failure_reason" IS NULL OR "outbound_commands"."failure_reason" ~ '^[A-Z][A-Z0-9_]{0,63}$');