import { z } from 'zod';
import { SkuStatus, SkuSummary } from './skus.js';

/** A season filter: a season id, or `none` for styles with no season (spec 0012, AC-4). */
export const SeasonFilter = z.union([z.uuid(), z.literal('none')]);
/** The validated shape of `SeasonFilter`, as the api and web see it after parsing. */
export type SeasonFilter = z.infer<typeof SeasonFilter>;

/**
 * Query of `GET /api/skus` (spec 0012, AC-3 and AC-4). `q` (trimmed, 1 to 100 characters)
 * matches an exact barcode, a code prefix, or, when it has a word of 3 or more characters,
 * every word of its normalized form in the variant's search text. `seasonId`, `productGroupId`,
 * and `styleId` filter and combine with `q`. The receipt line picker sends `limit=20`.
 */
export const SkuListQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: SkuStatus.default('active'),
  seasonId: SeasonFilter.optional(),
  productGroupId: z.uuid().optional(),
  styleId: z.uuid().optional(),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
/** The validated shape of `SkuListQuery`, as the api and web see it after parsing. */
export type SkuListQuery = z.infer<typeof SkuListQuery>;

/** One page of `GET /api/skus`; pass `nextCursor` back as `cursor` for the next page, null at the end. */
export const SkuListResponse = z.object({
  items: z.array(SkuSummary),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `SkuListResponse`, as the api and web see it after parsing. */
export type SkuListResponse = z.infer<typeof SkuListResponse>;
