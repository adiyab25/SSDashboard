CREATE TYPE "public"."product_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."variant_kind" AS ENUM('stocked', 'service', 'bundle');--> statement-breakpoint
CREATE TYPE "public"."variant_tracking" AS ENUM('none', 'lot', 'serial');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_kind" AS ENUM('balance', 'reservation', 'serial');--> statement-breakpoint
CREATE TYPE "public"."discrepancy_resolution" AS ENUM('rebuilt', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."movement_source_type" AS ENUM('opening_balance', 'purchase_receipt', 'purchase_return', 'sales_shipment', 'sales_return', 'transfer_out', 'transfer_in', 'adjustment', 'count', 'production_consume', 'production_output', 'stock_receipt');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('active', 'released', 'fulfilled');--> statement-breakpoint
CREATE TYPE "public"."serial_status" AS ENUM('in_stock', 'out');--> statement-breakpoint
CREATE TYPE "public"."bin_level" AS ENUM('zone', 'aisle', 'shelf', 'bin');--> statement-breakpoint
CREATE TYPE "public"."location_type" AS ENUM('warehouse', 'showroom', 'transit', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."custom_field_type" AS ENUM('text', 'number', 'boolean', 'date', 'select');--> statement-breakpoint
CREATE TYPE "public"."stock_receipt_status" AS ENUM('posted', 'voided');--> statement-breakpoint
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
	CONSTRAINT "product_variants_tracking_stocked_only" CHECK ("product_variants"."tracking" = 'none' OR "product_variants"."kind" = 'stocked')
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"status" "product_status" DEFAULT 'draft' NOT NULL,
	"brand" text,
	"product_type" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
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
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "stock_movements_quantity_not_zero" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_cost_sign" CHECK ("stock_movements"."total_cost" = 0 OR sign("stock_movements"."total_cost") = sign("stock_movements"."quantity"))
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
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"type" "location_type" NOT NULL,
	"is_sellable" boolean DEFAULT true NOT NULL,
	"allow_negative" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "locations_code_unique" UNIQUE("tenant_id","code")
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
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_factory" boolean DEFAULT false NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "parties_code_unique" UNIQUE("tenant_id","code"),
	CONSTRAINT "parties_has_a_role" CHECK ("parties"."is_supplier" OR "parties"."is_customer" OR "parties"."is_factory")
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
CREATE TABLE "settings" (
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "settings_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
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
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "barcodes" ADD CONSTRAINT "barcodes_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_base_uom_id_uoms_id_fk" FOREIGN KEY ("base_uom_id") REFERENCES "public"."uoms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_uom_conversions" ADD CONSTRAINT "variant_uom_conversions_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_uom_conversions" ADD CONSTRAINT "variant_uom_conversions_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_receipt_id_stock_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."stock_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_movement_group_id_movement_groups_id_fk" FOREIGN KEY ("movement_group_id") REFERENCES "public"."movement_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_void_group_id_movement_groups_id_fk" FOREIGN KEY ("void_group_id") REFERENCES "public"."movement_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_unique" ON "accounts" USING btree ("tenant_id","provider_id","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_key_unique" ON "rate_limits" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "two_factors_user_unique" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("tenant_id",lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_staff_code_unique" ON "users" USING btree ("tenant_id","staff_code") WHERE "users"."staff_code" is not null;--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier","expires_at");--> statement-breakpoint
CREATE INDEX "barcodes_variant_idx" ON "barcodes" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "barcodes_uom_idx" ON "barcodes" USING btree ("uom_id");--> statement-breakpoint
CREATE INDEX "product_variants_product_idx" ON "product_variants" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "product_variants_sku_c_idx" ON "product_variants" USING btree ("sku" COLLATE "C");--> statement-breakpoint
CREATE INDEX "products_tags_idx" ON "products" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "variant_uom_conversions_uom_idx" ON "variant_uom_conversions" USING btree ("uom_id");--> statement-breakpoint
CREATE INDEX "movement_groups_source_idx" ON "movement_groups" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "movement_serials_serial_idx" ON "movement_serials" USING btree ("serial_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_active_source_line_unique" ON "reservations" USING btree ("tenant_id","source_type","source_line_id") WHERE "reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "reservations_active_balance_idx" ON "reservations" USING btree ("variant_id","location_id","lot_id") WHERE "reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "serials_place_idx" ON "serials" USING btree ("variant_id","location_id","bin_id") WHERE "serials"."status" = 'in_stock';--> statement-breakpoint
CREATE INDEX "stock_level_discrepancies_stock_level_idx" ON "stock_level_discrepancies" USING btree ("stock_level_id");--> statement-breakpoint
CREATE INDEX "stock_levels_location_variant_idx" ON "stock_levels" USING btree ("location_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_levels_updated_idx" ON "stock_levels" USING btree ("updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_movements_variant_location_effective_idx" ON "stock_movements" USING btree ("variant_id","location_id","effective_at");--> statement-breakpoint
CREATE INDEX "stock_movements_group_idx" ON "stock_movements" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "stock_movements_variant_recorded_idx" ON "stock_movements" USING btree ("variant_id","recorded_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_movements_recorded_brin" ON "stock_movements" USING brin ("recorded_at");--> statement-breakpoint
CREATE INDEX "stock_movements_lot_idx" ON "stock_movements" USING btree ("lot_id") WHERE "stock_movements"."lot_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bins_parent_idx" ON "bins" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "stock_receipt_lines_variant_idx" ON "stock_receipt_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_receipts_effective_idx" ON "stock_receipts" USING btree ("effective_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_receipts_location_effective_idx" ON "stock_receipts" USING btree ("location_id","effective_at" DESC NULLS LAST,"id" DESC NULLS LAST);