CREATE TYPE "public"."stock_out_source" AS ENUM('carrier_shipped', 'shopify_fulfillment', 'pick_pack_ship');--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "stock_out_quantity" integer;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "awaiting_restock_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "awaiting_restock_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stock_out_generation" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stock_out_source" "stock_out_source";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "stock_out_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "order_lines_awaiting_restock_idx" ON "order_lines" USING btree ("variant_id","awaiting_restock_since") WHERE "order_lines"."awaiting_restock_quantity" > 0;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_stock_out_within_quantity" CHECK ("order_lines"."stock_out_quantity" IS NULL OR ("order_lines"."stock_out_quantity" >= 0 AND "order_lines"."stock_out_quantity" <= "order_lines"."quantity"));--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_awaiting_within_stock_out" CHECK ("order_lines"."awaiting_restock_quantity" >= 0 AND "order_lines"."awaiting_restock_quantity" <= coalesce("order_lines"."stock_out_quantity", 0));--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_awaiting_since_pair" CHECK (("order_lines"."awaiting_restock_quantity" = 0) = ("order_lines"."awaiting_restock_since" IS NULL));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_stock_out_generation_positive" CHECK ("orders"."stock_out_generation" >= 1);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_stock_out_request_pair" CHECK (("orders"."stock_out_source" IS NULL) = ("orders"."stock_out_requested_at" IS NULL));