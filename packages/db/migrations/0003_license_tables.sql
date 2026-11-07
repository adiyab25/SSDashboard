CREATE TYPE "public"."license_check_outcome" AS ENUM('valid', 'already_recorded', 'none_configured', 'file_missing', 'file_unreadable', 'bad_format', 'bad_signature', 'unknown_key', 'dev_key_in_production', 'wrong_install');--> statement-breakpoint
CREATE TYPE "public"."license_check_trigger" AS ENUM('api_start', 'worker_start', 'daily', 'upload');--> statement-breakpoint
CREATE TYPE "public"."license_phase" AS ENUM('not_licensed', 'active', 'expiring', 'grace', 'wind_down', 'off');--> statement-breakpoint
CREATE TYPE "public"."license_source" AS ENUM('file', 'upload');--> statement-breakpoint
CREATE TABLE "license_checks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "license_checks_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"trigger" "license_check_trigger" NOT NULL,
	"outcome" "license_check_outcome" NOT NULL,
	"file_sha256" text,
	"license_row_id" uuid,
	"operations_phase" "license_phase" NOT NULL,
	"warehouse_phase" "license_phase" NOT NULL,
	"wind_down_ended_at" timestamp with time zone,
	"clock_behind" boolean DEFAULT false NOT NULL,
	CONSTRAINT "license_checks_warehouse_never_winds_down" CHECK ("license_checks"."warehouse_phase" <> 'wind_down'),
	CONSTRAINT "license_checks_file_sha256_shape" CHECK ("license_checks"."file_sha256" IS NULL OR "license_checks"."file_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"license_id" text NOT NULL,
	"key_id" text NOT NULL,
	"envelope" text NOT NULL,
	"sha256" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"client_code" text NOT NULL,
	"bundles" text[] NOT NULL,
	"operations_expires_on" date,
	"warehouse_expires_on" date,
	"issued_on" date NOT NULL,
	"source" "license_source" NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid,
	CONSTRAINT "licenses_bundles_known" CHECK ("licenses"."bundles" <@ ARRAY['warehouse', 'operations']::text[] AND cardinality("licenses"."bundles") > 0),
	CONSTRAINT "licenses_operations_expiry" CHECK (('operations' = ANY("licenses"."bundles")) = ("licenses"."operations_expires_on" IS NOT NULL)),
	CONSTRAINT "licenses_warehouse_expiry" CHECK ("licenses"."warehouse_expires_on" IS NULL OR 'warehouse' = ANY("licenses"."bundles")),
	CONSTRAINT "licenses_envelope_size" CHECK (length("licenses"."envelope") <= 16384),
	CONSTRAINT "licenses_sha256_shape" CHECK ("licenses"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "licenses_payload_sha256_shape" CHECK ("licenses"."payload_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "license_checks" ADD CONSTRAINT "license_checks_license_row_id_licenses_id_fk" FOREIGN KEY ("license_row_id") REFERENCES "public"."licenses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "license_checks_checked_at_idx" ON "license_checks" USING btree ("checked_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "license_checks_seq_idx" ON "license_checks" USING btree ("seq" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "license_checks_license_row_idx" ON "license_checks" USING btree ("license_row_id");--> statement-breakpoint
CREATE INDEX "licenses_recorded_by_idx" ON "licenses" USING btree ("recorded_by");