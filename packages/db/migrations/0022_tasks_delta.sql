ALTER TYPE "public"."task_linked_type" ADD VALUE 'connection';--> statement-breakpoint
ALTER TYPE "public"."task_linked_type" ADD VALUE 'inbound_event';--> statement-breakpoint
ALTER TYPE "public"."task_linked_type" ADD VALUE 'variant';--> statement-breakpoint
ALTER TYPE "public"."task_linked_type" ADD VALUE 'install';--> statement-breakpoint
CREATE TABLE "task_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid DEFAULT current_setting('ssd.tenant_id')::uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"note" text NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_notes_note_length" CHECK (char_length("task_notes"."note") BETWEEN 1 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_key" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "contact_channel" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_notes" ADD CONSTRAINT "task_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_notes_task_idx" ON "task_notes" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_notes_author_idx" ON "task_notes" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "tasks_dedupe_key_idx" ON "tasks" USING btree ("tenant_id","dedupe_key") WHERE "tasks"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tasks_open_due_idx" ON "tasks" USING btree ("due_at","created_at","id") WHERE "tasks"."status" = 'open';--> statement-breakpoint
CREATE INDEX "tasks_open_subject_idx" ON "tasks" USING btree ("type","subject_key") WHERE "tasks"."status" = 'open';--> statement-breakpoint
CREATE INDEX "tasks_external_ref_idx" ON "tasks" USING btree ("external_ref") WHERE "tasks"."external_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_hat_set" CHECK ("tasks"."owner_hat" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_note_length" CHECK ("tasks"."note" IS NULL OR char_length("tasks"."note") BETWEEN 1 AND 1000);--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_subject_key_shape" CHECK ("tasks"."subject_key" IS NULL OR "tasks"."subject_key" ~ '^[a-z0-9:_.-]{1,120}$');--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_contact_channel_known" CHECK ("tasks"."contact_channel" IS NULL OR "tasks"."contact_channel" IN ('whatsapp', 'call', 'instagram', 'facebook', 'portal'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_external_ref_shape" CHECK ("tasks"."external_ref" IS NULL OR "tasks"."external_ref" ~ '^[A-Za-z0-9-]{1,40}$');