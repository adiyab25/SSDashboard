CREATE TYPE "public"."stock_receipt_status" AS ENUM('posted', 'voided');--> statement-breakpoint
ALTER TYPE "public"."movement_source_type" ADD VALUE 'stock_receipt';--> statement-breakpoint
CREATE TABLE "stock_receipt_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"receipt_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"uom_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost" numeric(14, 4) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	CONSTRAINT "stock_receipt_lines_receipt_variant_unique" UNIQUE("receipt_id","variant_id"),
	CONSTRAINT "stock_receipt_lines_receipt_position_unique" UNIQUE("receipt_id","position"),
	CONSTRAINT "stock_receipt_lines_position_range" CHECK ("stock_receipt_lines"."position" BETWEEN 1 AND 200),
	CONSTRAINT "stock_receipt_lines_quantity_range" CHECK ("stock_receipt_lines"."quantity" BETWEEN 1 AND 1000000),
	CONSTRAINT "stock_receipt_lines_unit_cost_not_negative" CHECK ("stock_receipt_lines"."unit_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
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
	CONSTRAINT "stock_receipts_number_unique" UNIQUE("number"),
	CONSTRAINT "stock_receipts_movement_group_id_unique" UNIQUE("movement_group_id"),
	CONSTRAINT "stock_receipts_void_group_id_unique" UNIQUE("void_group_id"),
	CONSTRAINT "stock_receipts_reference_length" CHECK ("stock_receipts"."reference" IS NULL OR char_length("stock_receipts"."reference") BETWEEN 1 AND 64),
	CONSTRAINT "stock_receipts_note_length" CHECK ("stock_receipts"."note" IS NULL OR char_length("stock_receipts"."note") BETWEEN 1 AND 500),
	CONSTRAINT "stock_receipts_void_reason_length" CHECK ("stock_receipts"."void_reason" IS NULL OR char_length("stock_receipts"."void_reason") BETWEEN 1 AND 500),
	CONSTRAINT "stock_receipts_voided_fields" CHECK (num_nonnulls("stock_receipts"."voided_at", "stock_receipts"."voided_by", "stock_receipts"."void_reason", "stock_receipts"."void_group_id") = CASE WHEN "stock_receipts"."status" = 'voided' THEN 4 ELSE 0 END)
);
--> statement-breakpoint
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipt_lines" ADD CONSTRAINT "stock_receipt_lines_receipt_id_stock_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."stock_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_movement_group_id_movement_groups_id_fk" FOREIGN KEY ("movement_group_id") REFERENCES "public"."movement_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_receipts" ADD CONSTRAINT "stock_receipts_void_group_id_movement_groups_id_fk" FOREIGN KEY ("void_group_id") REFERENCES "public"."movement_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_receipt_lines_variant_idx" ON "stock_receipt_lines" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "stock_receipts_effective_idx" ON "stock_receipts" USING btree ("effective_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_receipts_location_effective_idx" ON "stock_receipts" USING btree ("location_id","effective_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "product_variants_sku_c_idx" ON "product_variants" USING btree ("sku" COLLATE "C");--> statement-breakpoint
CREATE INDEX "stock_levels_updated_idx" ON "stock_levels" USING btree ("updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_movements_variant_recorded_idx" ON "stock_movements" USING btree ("variant_id","recorded_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
-- Hand written (spec 0006). Lines are write once and receipts are never deleted: take back the
-- UPDATE and DELETE the default privileges of 0001 gave the application role. It keeps UPDATE on
-- stock_receipts for the void columns.
REVOKE UPDATE, DELETE, TRUNCATE ON "stock_receipt_lines" FROM ssdashboard_app;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "stock_receipts" FROM ssdashboard_app;--> statement-breakpoint
-- The stock receipt number prefix, merged so every other prefix is kept.
UPDATE "settings" SET "value" = "value" || '{"stock_receipt": "SR"}'::jsonb WHERE "key" = 'document_prefixes';
