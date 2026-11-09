CREATE TYPE "public"."option_role" AS ENUM('size', 'color', 'other');--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "product_groups" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "product_options" ADD COLUMN "role" "option_role" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "seasons" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "seasons" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_options_unique" ON "product_variants" USING btree ("tenant_id","product_id","option_values") WHERE "product_variants"."archived_at" IS NULL;