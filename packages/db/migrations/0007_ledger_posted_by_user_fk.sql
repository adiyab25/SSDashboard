-- AC-22 (spec 0005): movement_groups.posted_by becomes a nullable foreign key to users.id.
-- Orders matter here: add NOT VALID, null out orphans, then VALIDATE. Drizzle runs the whole migration in one
-- transaction, so the locks taken by each statement are held until it commits; plan a quiet window.
--
-- Nulling out is an UPDATE on an append only table. The application role has no UPDATE grant
-- on it, but the "movement_groups_append_only" trigger rejects UPDATE for every role, the
-- owner included. This migration runs as the owner role, in one transaction: it disables that
-- one trigger, runs the one UPDATE (which only ever sets posted_by to NULL), and re-enables
-- the trigger before the transaction ends. If any step fails the whole migration rolls back,
-- so the trigger can never be left disabled. DISABLE TRIGGER takes a SHARE ROW EXCLUSIVE lock
-- on movement_groups, so no application writer can slip a change in meanwhile.
ALTER TABLE "movement_groups" ADD CONSTRAINT "movement_groups_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "movement_groups" DISABLE TRIGGER "movement_groups_append_only";--> statement-breakpoint
UPDATE "movement_groups" SET "posted_by" = NULL WHERE "posted_by" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" WHERE "users"."id" = "movement_groups"."posted_by");--> statement-breakpoint
ALTER TABLE "movement_groups" ENABLE TRIGGER "movement_groups_append_only";--> statement-breakpoint
ALTER TABLE "movement_groups" VALIDATE CONSTRAINT "movement_groups_posted_by_users_id_fk";
