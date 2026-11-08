CREATE TYPE "public"."merge_suggestion_reason" AS ENUM('channel_id_conflict', 'second_phone_conflict');--> statement-breakpoint
CREATE TYPE "public"."merge_suggestion_status" AS ENUM('open', 'applied', 'dismissed');--> statement-breakpoint
CREATE TABLE "customer_merge_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"customer_low_id" uuid NOT NULL,
	"customer_high_id" uuid NOT NULL,
	"reason" "merge_suggestion_reason" NOT NULL,
	"evidence_external_id_id" uuid,
	"evidence_phone_id" uuid,
	"status" "merge_suggestion_status" DEFAULT 'open' NOT NULL,
	"merge_id" uuid,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"dismiss_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_merge_suggestions_pair_unique" UNIQUE("customer_low_id","customer_high_id"),
	CONSTRAINT "customer_merge_suggestions_ordered" CHECK ("customer_merge_suggestions"."customer_low_id" < "customer_merge_suggestions"."customer_high_id"),
	CONSTRAINT "customer_merge_suggestions_channel_evidence" CHECK (("customer_merge_suggestions"."reason" = 'channel_id_conflict') = ("customer_merge_suggestions"."evidence_external_id_id" IS NOT NULL)),
	CONSTRAINT "customer_merge_suggestions_phone_evidence" CHECK (("customer_merge_suggestions"."reason" = 'second_phone_conflict') = ("customer_merge_suggestions"."evidence_phone_id" IS NOT NULL)),
	CONSTRAINT "customer_merge_suggestions_applied_has_merge" CHECK (("customer_merge_suggestions"."status" = 'applied') = ("customer_merge_suggestions"."merge_id" IS NOT NULL)),
	CONSTRAINT "customer_merge_suggestions_open_is_undecided" CHECK (("customer_merge_suggestions"."status" = 'open') = ("customer_merge_suggestions"."decided_at" IS NULL)),
	CONSTRAINT "customer_merge_suggestions_dismiss_reason" CHECK (("customer_merge_suggestions"."dismiss_reason" IS NULL OR "customer_merge_suggestions"."status" = 'dismissed') AND ("customer_merge_suggestions"."dismiss_reason" IS NULL OR "customer_merge_suggestions"."dismiss_reason" ~ '^[a-z][a-z0-9_.]{0,63}$'))
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "risk_flag_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "risk_flag_set_by" uuid;--> statement-breakpoint
ALTER TABLE "customer_merge_suggestions" ADD CONSTRAINT "customer_merge_suggestions_customer_low_id_customers_id_fk" FOREIGN KEY ("customer_low_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge_suggestions" ADD CONSTRAINT "customer_merge_suggestions_customer_high_id_customers_id_fk" FOREIGN KEY ("customer_high_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge_suggestions" ADD CONSTRAINT "customer_merge_suggestions_evidence_external_id_id_customer_external_ids_id_fk" FOREIGN KEY ("evidence_external_id_id") REFERENCES "public"."customer_external_ids"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge_suggestions" ADD CONSTRAINT "customer_merge_suggestions_evidence_phone_id_customer_phones_id_fk" FOREIGN KEY ("evidence_phone_id") REFERENCES "public"."customer_phones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge_suggestions" ADD CONSTRAINT "customer_merge_suggestions_merge_id_customer_merges_id_fk" FOREIGN KEY ("merge_id") REFERENCES "public"."customer_merges"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge_suggestions" ADD CONSTRAINT "customer_merge_suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_merge_suggestions_open_idx" ON "customer_merge_suggestions" USING btree ("created_at","id") WHERE "customer_merge_suggestions"."status" = 'open';--> statement-breakpoint
CREATE INDEX "customer_merge_suggestions_high_idx" ON "customer_merge_suggestions" USING btree ("customer_high_id");--> statement-breakpoint
CREATE INDEX "customer_merge_suggestions_evidence_external_idx" ON "customer_merge_suggestions" USING btree ("evidence_external_id_id") WHERE "customer_merge_suggestions"."evidence_external_id_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_merge_suggestions_evidence_phone_idx" ON "customer_merge_suggestions" USING btree ("evidence_phone_id") WHERE "customer_merge_suggestions"."evidence_phone_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_merge_suggestions_merge_idx" ON "customer_merge_suggestions" USING btree ("merge_id") WHERE "customer_merge_suggestions"."merge_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_merge_suggestions_decided_by_idx" ON "customer_merge_suggestions" USING btree ("decided_by") WHERE "customer_merge_suggestions"."decided_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_risk_flag_set_by_users_id_fk" FOREIGN KEY ("risk_flag_set_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_risk_flag_set_by_idx" ON "customers" USING btree ("risk_flag_set_by") WHERE "customers"."risk_flag_set_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customers_flagged_idx" ON "customers" USING btree ("risk_flag_set_at" DESC NULLS FIRST,"id" DESC NULLS FIRST) WHERE "customers"."risk_flag" IS NOT NULL AND "customers"."merged_into_id" IS NULL;--> statement-breakpoint
CREATE INDEX "customers_name_trgm_idx" ON "customers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_risk_flag_set_by_is_manual" CHECK ("customers"."risk_flag_set_by" IS NULL OR "customers"."risk_flag_source" = 'manual');