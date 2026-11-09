-- Hand written (spec 0012, milestone 1): the search normalization and the triggers that keep
-- `product_variants.search_text` (added by 0013_catalog_search_text.sql) true on every write
-- path. Edited by hand, never generated.

-- AC-1: the only normalization of search text, used by the stored column and by every query.
-- In order: lowercase; Arabic Indic (U+0660..U+0669) and Eastern Arabic Indic (U+06F0..U+06F9)
-- digits to 0..9; hamza forms of alef (U+0623, U+0625, U+0622, U+0671) to bare alef, alef
-- maqsura (U+0649) and yeh with hamza (U+0626) to yeh, waw with hamza (U+0624) to waw, teh
-- marbuta (U+0629) to heh; the Arabic marks U+064B..U+065F and U+0670 and the tatweel U+0640
-- removed (translate drops every source character past the end of the target list); every run
-- of characters that are not a letter or a digit to one space; trimmed.
-- A plain sql function with no SET clause and only immutable calls, so the planner inlines it
-- (like ssd_operating_day). The text carries the builtin "pg_c_utf8" collation, whose Unicode
-- letter, digit, and case rules do not depend on the database or operating system locale, so
-- the answer is the same on every install of one PostgreSQL major version and IMMUTABLE is
-- honest there. Those rules follow the Unicode tables built into PostgreSQL, which can change
-- between major versions: after a major upgrade, restamp every variant with
-- `UPDATE product_variants SET search_text = search_text` (the backfill at the end of this file);
-- feature 26's upgrade runbook owns that step. No index is built on this function, so nothing
-- is corrupted meanwhile; only a newly classified character could mismatch.
-- Even the concatenation operator is schema qualified, so the body never depends on the search
-- path; the planner still inlines it (search-normalize.e2e-spec.ts checks the plan).
CREATE FUNCTION "ssd_search_normalize"(input text) RETURNS text IMMUTABLE PARALLEL SAFE LANGUAGE sql AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.translate(
      pg_catalog.lower(input COLLATE pg_catalog."pg_c_utf8"),
      U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669'
        OPERATOR(pg_catalog.||) U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9'
        OPERATOR(pg_catalog.||) U&'\0623\0625\0622\0671\0649\0626\0624\0629'
        OPERATOR(pg_catalog.||) U&'\064B\064C\064D\064E\064F\0650\0651\0652\0653\0654\0655\0656\0657\0658\0659\065A\065B\065C\065D\065E\065F\0670\0640',
      '01234567890123456789' OPERATOR(pg_catalog.||) U&'\0627\0627\0627\0627\064A\064A\0648\0647'),
    '[^[:alnum:]]+', ' ', 'g'))
$$;--> statement-breakpoint

-- AC-2: the search document of one variant: the style's English and Arabic names, the style
-- code, the SKU code, and the English and Arabic labels of each of the variant's option values
-- (`product_options.values[option_values[position]]`), space joined, then normalized. Reads
-- the catalog tables, so STABLE; '' for an unknown style. The option value lookup
-- `o.values -> ((option_values ->> o.position::text)::int)` is repeated by the SKU list
-- (`apps/api/src/catalog/search/sku-list-sql.ts`); change both together.
CREATE FUNCTION "ssd_variant_search_text"(style_id uuid, variant_sku text, variant_option_values jsonb) RETURNS text STABLE PARALLEL SAFE LANGUAGE sql SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce((
    SELECT public.ssd_search_normalize(pg_catalog.concat_ws(' ',
      p.name ->> 'en', p.name ->> 'ar', p.style_code, variant_sku,
      (SELECT pg_catalog.string_agg(
                pg_catalog.concat_ws(' ', l.label ->> 'en', l.label ->> 'ar'), ' ' ORDER BY o.position)
         FROM public.product_options o,
              LATERAL (SELECT o.values -> ((variant_option_values ->> o.position::text)::int)) AS l(label)
        WHERE o.product_id = p.id AND l.label IS NOT NULL)))
    FROM public.products p
    WHERE p.id = style_id), '')
$$;--> statement-breakpoint

-- A variant's own write: inserting it, or changing its code, option values, or style, restamps
-- its document. Writing search_text itself also restamps it, so no writer can store a value
-- other than the recomputation (the two follow triggers below rely on that).
--
-- Overlapping writes (review of spec 0012 M1, major). The follow triggers below restamp only the
-- variants their statement can see, so a variant that enters a style (insert, or a move to
-- another style) while that style is renamed or its options change would keep the old text:
-- the foreign key check takes only FOR KEY SHARE on the style row, which a rename's FOR NO KEY
-- UPDATE does not wait for. So such a write first takes FOR SHARE on its style row, which
-- conflicts with both the rename's row lock and the FOR NO KEY UPDATE the options follow
-- trigger takes, and each side waits for the other:
--   * variant first: the rename (or option write) waits until the variant commits; its follow
--     UPDATE is a new statement in a VOLATILE plpgsql function, so under READ COMMITTED it takes
--     a new snapshot, sees the committed variant, and restamps it.
--   * rename (or option write) first: the variant's FOR SHARE waits for it to commit, then locks
--     the newest row version; the assignment below is the next statement of this VOLATILE
--     function, so it takes a new snapshot and reads the new name and options.
-- An update that keeps the style needs no lock: the variant row is already visible to the
-- follow trigger, and its row lock orders the two writes (the later one is re-evaluated on the
-- newest row version and recomputes from a new snapshot). Locking only on entry also keeps the
-- order the follow triggers use, style row then variant rows (like inventory's lockForShare
-- callers, spec 0011), so a variant update cannot deadlock a rename.
-- REPEATABLE READ and SERIALIZABLE: a variant writer that waited here gets a serialization
-- error (the style row changed since its snapshot), which is safe to retry. A REPEATABLE READ
-- rename or option write that waited on a variant insert keeps its old snapshot and would miss
-- that variant, so writers of products and product_options must run READ COMMITTED (every api
-- write path does; SERIALIZABLE refuses one of the two instead).
CREATE FUNCTION "product_variants_stamp_search_text"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.product_id IS DISTINCT FROM OLD.product_id THEN
    PERFORM 1 FROM public.products WHERE id = NEW.product_id FOR SHARE;
  END IF;
  NEW.search_text := public.ssd_variant_search_text(NEW.product_id, NEW.sku, NEW.option_values);
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "product_variants_search_text" BEFORE INSERT OR UPDATE OF "sku", "option_values", "product_id", "search_text" ON "product_variants" FOR EACH ROW EXECUTE FUNCTION "product_variants_stamp_search_text"();--> statement-breakpoint

-- A style rename or recode restamps that style's variants only, through the stamp trigger
-- above (`SET search_text = search_text` names the column, so it fires). It never touches
-- their updated_at: a style rename is not an edit of the SKU (AC-2).
CREATE FUNCTION "products_search_text_follow"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.product_variants SET search_text = search_text WHERE product_id = NEW.id;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "products_search_text_follows" AFTER UPDATE OF "name", "style_code" ON "products" FOR EACH ROW WHEN (OLD."name" IS DISTINCT FROM NEW."name" OR OLD."style_code" IS DISTINCT FROM NEW."style_code") EXECUTE FUNCTION "products_search_text_follow"();--> statement-breakpoint

-- Adding, changing, or removing a style's option (its values are the labels in the document)
-- restamps that style's variants, and both styles' when an option moves between them. It first
-- locks the affected style rows FOR NO KEY UPDATE in id order (the lock a rename holds), so a
-- variant entering one of those styles waits for it, or it waits for that variant; see the
-- stamp trigger above.
CREATE FUNCTION "product_options_search_text_follow"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.products
   WHERE id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.product_id END,
                CASE WHEN TG_OP <> 'DELETE' THEN NEW.product_id END)
   ORDER BY id
   FOR NO KEY UPDATE;
  IF TG_OP <> 'INSERT' THEN
    UPDATE public.product_variants SET search_text = search_text WHERE product_id = OLD.product_id;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    UPDATE public.product_variants SET search_text = search_text WHERE product_id = NEW.product_id;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "product_options_search_text_follows" AFTER INSERT OR UPDATE OR DELETE ON "product_options" FOR EACH ROW EXECUTE FUNCTION "product_options_search_text_follow"();--> statement-breakpoint

-- Backfill every existing variant in SQL through the stamp trigger (the column arrived empty in
-- 0013). The trigram index 0013 built takes the new values as they are written.
UPDATE "product_variants" SET "search_text" = "search_text";
