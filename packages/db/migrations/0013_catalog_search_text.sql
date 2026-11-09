DROP INDEX "product_variants_sku_trgm_idx";--> statement-breakpoint
DROP INDEX "products_search_trgm_idx";--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "search_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "product_variants_search_trgm_idx" ON "product_variants" USING gin ("search_text" gin_trgm_ops);