import { z } from 'zod';

/**
 * What a style's option axis means (spec 0012, AC-10), the twin of the database enum
 * `option_role` (`packages/db/test/enum-parity.e2e-spec.ts`). Never reorder: the database enum
 * holds the same values in this order.
 */
export const OptionRole = z.enum(['size', 'color', 'other']);
/** The validated shape of `OptionRole`, as the api and web see it after parsing. */
export type OptionRole = z.infer<typeof OptionRole>;

/**
 * The option names that give an option its role (spec 0012, AC-10), already in the form
 * `ssd_search_normalize` returns, so the api compares `ssd_search_normalize(name)` against them
 * in SQL. A name in neither list is `other`. The migration `0016_catalog_option_roles.sql`
 * backfilled existing options from these same lists; adding a name here changes only options
 * created later (never re infer an existing option's role from here).
 */
export const OPTION_ROLE_NAMES = {
  size: ['size', 'sizes', 'مقاس', 'المقاس', 'القياس'],
  color: ['color', 'colour', 'لون', 'اللون'],
} as const satisfies Record<Exclude<OptionRole, 'other'>, readonly string[]>;
