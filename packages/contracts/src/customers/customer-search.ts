import { z } from 'zod';
import { CustomerBrief } from './customer-views.js';

/**
 * The stable error code of a search refused by the per person throttle (429): a person who calls
 * `POST /api/customers/search` more often than the api allows a minute waits for the
 * `Retry-After` seconds the answer names.
 */
export const CUSTOMER_SEARCH_RATE_LIMITED = 'SEARCH_RATE_LIMITED';

/**
 * `POST /api/customers/search` (spec 0014 AC-3, AC-5): exactly one of `phone` (any form),
 * `nameContains` (3 to 100 characters), or `flagged: true`. A POST so a phone or name never lands
 * in a URL. A body with none, or more than one, is 400 `INVALID_QUERY`.
 */
export const CustomerSearchRequest = z
  .strictObject({
    phone: z.string().min(1).max(64).optional(),
    nameContains: z
      .string()
      .trim()
      .min(3)
      .max(100)
      .refine((text) => /[\p{L}\p{N}]/u.test(text), {
        message: 'A name fragment needs at least one letter or digit',
      })
      .optional(),
    flagged: z.literal(true).optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .refine(
    (body) =>
      [
        body.phone !== undefined,
        body.nameContains !== undefined,
        body.flagged !== undefined,
      ].filter(Boolean).length === 1,
    { message: 'Give exactly one of phone, nameContains, or flagged' },
  );
/** The validated shape of `CustomerSearchRequest`, after defaults. */
export type CustomerSearchRequest = z.infer<typeof CustomerSearchRequest>;

/** The answer of `POST /api/customers/search`: canonical customers only, keyset paged. */
export const CustomerSearchResponse = z.object({
  items: z.array(CustomerBrief),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `CustomerSearchResponse`. */
export type CustomerSearchResponse = z.infer<typeof CustomerSearchResponse>;
