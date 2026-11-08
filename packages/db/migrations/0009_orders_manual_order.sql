ALTER TABLE "order_lines" ADD COLUMN "short_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "channel_order_ref" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "customer_note" text;--> statement-breakpoint
CREATE INDEX "order_lines_short_idx" ON "order_lines" USING btree ("order_id") WHERE "order_lines"."short_quantity" > 0;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_store_channel_ref_unique" ON "orders" USING btree ("tenant_id","store_id","channel_order_ref") WHERE "orders"."channel_order_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_placed_idx" ON "orders" USING btree ("placed_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "orders_fulfillment_placed_idx" ON "orders" USING btree ("fulfillment_state","placed_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "orders_order_number_idx" ON "orders" USING btree ("order_number");--> statement-breakpoint
CREATE INDEX "orders_ship_to_phone_idx" ON "orders" USING btree ("ship_to_phone") WHERE "orders"."ship_to_phone" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_ship_to_phone_alt_idx" ON "orders" USING btree ("ship_to_phone_alt") WHERE "orders"."ship_to_phone_alt" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_short_within_quantity" CHECK ("order_lines"."short_quantity" >= 0 AND "order_lines"."short_quantity" <= "order_lines"."quantity");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_channel_order_ref_length" CHECK ("orders"."channel_order_ref" IS NULL OR length("orders"."channel_order_ref") <= 255);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_note_length" CHECK ("orders"."customer_note" IS NULL OR length("orders"."customer_note") <= 2000);