CREATE TYPE "public"."stock_transfer_kind" AS ENUM('send_to_partner', 'return_from_partner');--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"number" text NOT NULL,
	"kind" "stock_transfer_kind" NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"reference" text,
	"request_hash" text NOT NULL,
	"movement_group_id" uuid NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"posted_by" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_transfers_number_unique" UNIQUE("tenant_id","number"),
	CONSTRAINT "stock_transfers_movement_group_unique" UNIQUE("movement_group_id"),
	CONSTRAINT "stock_transfers_locations_differ" CHECK ("stock_transfers"."from_location_id" <> "stock_transfers"."to_location_id"),
	CONSTRAINT "stock_transfers_reference_length" CHECK ("stock_transfers"."reference" IS NULL OR char_length("stock_transfers"."reference") BETWEEN 1 AND 64)
);
--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_quantity_positive";--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_open_while_active";--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "unfilled_quantity" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "stock_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "stock_verified_by" uuid;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_location_id_locations_id_fk" FOREIGN KEY ("from_location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_location_id_locations_id_fk" FOREIGN KEY ("to_location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_movement_group_id_movement_groups_id_fk" FOREIGN KEY ("movement_group_id") REFERENCES "public"."movement_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_transfers_from_location_idx" ON "stock_transfers" USING btree ("from_location_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_to_location_idx" ON "stock_transfers" USING btree ("to_location_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_posted_by_idx" ON "stock_transfers" USING btree ("posted_by");--> statement-breakpoint
CREATE INDEX "stock_transfers_recorded_idx" ON "stock_transfers" USING btree ("recorded_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_stock_verified_by_users_id_fk" FOREIGN KEY ("stock_verified_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reservations_location_updated_idx" ON "reservations" USING btree ("location_id","updated_at");--> statement-breakpoint
CREATE INDEX "reservations_source_idx" ON "reservations" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "reservations_waiting_idx" ON "reservations" USING btree ("variant_id","location_id","created_at","id") WHERE "reservations"."status" = 'active' AND "reservations"."unfilled_quantity" > 0;--> statement-breakpoint
CREATE INDEX "reservations_newest_idx" ON "reservations" USING btree ("variant_id","location_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "reservations"."status" = 'active' AND "reservations"."open_quantity" > 0;--> statement-breakpoint
CREATE INDEX "stock_levels_location_updated_idx" ON "stock_levels" USING btree ("location_id","updated_at");--> statement-breakpoint
CREATE INDEX "locations_stock_verified_by_idx" ON "locations" USING btree ("stock_verified_by") WHERE "locations"."stock_verified_by" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_one_online" ON "locations" USING btree ("tenant_id") WHERE "locations"."sellable_online" AND "locations"."archived_at" IS NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_quantity_not_negative" CHECK ("reservations"."quantity" >= 0);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_unfilled_not_negative" CHECK ("reservations"."unfilled_quantity" >= 0);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_has_demand" CHECK ("reservations"."status" <> 'active' OR "reservations"."quantity" + "reservations"."unfilled_quantity" > 0);--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_open_while_active" CHECK (("reservations"."status" = 'active') = ("reservations"."open_quantity" > 0 OR "reservations"."unfilled_quantity" > 0));--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_online_needs_warehouse" CHECK (NOT "locations"."sellable_online" OR ("locations"."kind" = 'warehouse' AND "locations"."is_sellable"));--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_online_not_archived" CHECK (NOT "locations"."sellable_online" OR "locations"."archived_at" IS NULL);