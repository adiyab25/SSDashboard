-- Hand written (spec 0012, milestone 2): the role of every option that existed before
-- `product_options.role` (added by 0015_catalog_styles.sql with the default 'other'), from its
-- name by the AC-10 rule: `size` when the normalized English or Arabic name is one of the size
-- names, `color` when it is one of the color names, else `other`. The two lists are
-- `OPTION_ROLE_NAMES` of `packages/contracts/src/catalog/option-roles.ts` as they stood at this
-- release (already normalized); the api uses that constant for every new option, and
-- `packages/db/test/catalog-styles-upgrade.e2e-spec.ts` proves the two agree. Edited by hand,
-- never generated. A data move only: no rule of the app role changes. Only an option whose role
-- changes is updated: every update of an option restamps its style's variants through
-- `product_options_search_text_follows`, so an option staying `other` is left alone (review of
-- milestone 2, minor 3).
UPDATE "product_options" AS o SET "role" = r."role"
FROM (
  SELECT "id", CASE
    WHEN public.ssd_search_normalize("name" ->> 'en') IN ('size', 'sizes', 'مقاس', 'المقاس', 'القياس')
      OR public.ssd_search_normalize("name" ->> 'ar') IN ('size', 'sizes', 'مقاس', 'المقاس', 'القياس')
      THEN 'size'::option_role
    WHEN public.ssd_search_normalize("name" ->> 'en') IN ('color', 'colour', 'لون', 'اللون')
      OR public.ssd_search_normalize("name" ->> 'ar') IN ('color', 'colour', 'لون', 'اللون')
      THEN 'color'::option_role
    ELSE 'other'::option_role
  END AS "role"
  FROM "product_options"
  WHERE "role" = 'other'
) AS r
WHERE o."id" = r."id" AND r."role" <> 'other';
