ALTER TABLE "barcodes" ADD COLUMN "from_channel" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "channel_linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "channel_linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "channel_name_language" text;--> statement-breakpoint
CREATE UNIQUE INDEX "barcodes_one_channel_code" ON "barcodes" USING btree ("tenant_id","variant_id") WHERE "barcodes"."from_channel";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_channel_name_language_known" CHECK ("products"."channel_name_language" IS NULL OR "products"."channel_name_language" IN ('en', 'ar'));