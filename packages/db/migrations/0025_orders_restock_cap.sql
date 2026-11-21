ALTER TABLE "order_lines" ADD COLUMN "restocked_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "closed_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "awaiting_restock_overdue_raised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "awaiting_restock_close_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "channel_return_source_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_restocked_closed_not_negative" CHECK ("order_lines"."restocked_quantity" >= 0 AND "order_lines"."closed_quantity" >= 0);--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_handled_within_stock_out" CHECK ("order_lines"."awaiting_restock_quantity" + "order_lines"."restocked_quantity" + "order_lines"."closed_quantity" <= coalesce("order_lines"."stock_out_quantity", 0));--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_overdue_within_spell" CHECK ("order_lines"."awaiting_restock_overdue_raised_at" IS NULL OR "order_lines"."awaiting_restock_since" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_close_request_within_spell" CHECK ("order_lines"."awaiting_restock_close_requested_at" IS NULL OR "order_lines"."awaiting_restock_since" IS NOT NULL);