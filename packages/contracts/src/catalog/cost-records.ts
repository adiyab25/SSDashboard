import { z } from 'zod';
import { moneyInput } from '../digit-input.js';
import { UnitCostString } from '../money.js';
import { CostBasis } from './cost-basis.js';
import { CatalogId } from './skus.js';

/**
 * The cost in force of one variant on a day (spec 0012, AC-12), as `CostService.costForMany`
 * answers it: `set` with the unit cost, its basis (an `estimate` is labelled so), the day the
 * record applies from, and whether the record is the style's (`inheritedFrom: 'style'`) or this
 * variant's override (`'variant'`); or `not_set` when no record applies, which must never be
 * shown or read as 0. Only a caller holding `cost.view` ever receives it.
 */
export const VariantCost = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('set'),
    unitCost: UnitCostString,
    costBasis: CostBasis,
    effectiveFrom: z.iso.date(),
    inheritedFrom: z.enum(['style', 'variant']),
  }),
  z.object({ status: z.literal('not_set') }),
]);
/** The validated shape of `VariantCost`, as the api and web see it after parsing. */
export type VariantCost = z.infer<typeof VariantCost>;

/**
 * Query of `GET /api/styles/:id/cost-records` (spec 0012, AC-13; `stock.view` and `cost.view`):
 * the page size (at most 50) and the cursor of the last page. Newest recorded first.
 */
export const CostRecordListQuery = z.object({
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});
/** The validated shape of `CostRecordListQuery`, as the api and web see it after parsing. */
export type CostRecordListQuery = z.infer<typeof CostRecordListQuery>;

/**
 * One cost record of a style (spec 0012, AC-13): the variant it overrides (null for the style's
 * own record), its season, basis, unit cost (`numeric` text with 4 decimals), the day it applies
 * from, the source (an invoice number, or null), when it was recorded (UTC with microseconds),
 * and who recorded it (null for a record no person entered, such as an import). Records are only
 * ever added; the reason of a backdated one is in its `cost_record.recorded` audit entry.
 */
export const CostRecordRow = z.object({
  id: z.uuid(),
  variant: z.object({ id: z.uuid(), code: z.string() }).nullable(),
  season: z.object({ id: z.uuid(), code: z.string() }),
  costBasis: CostBasis,
  unitCost: UnitCostString,
  effectiveFrom: z.iso.date(),
  source: z.string().nullable(),
  recordedAt: z.iso.datetime({ offset: true }),
  recordedBy: z.object({ id: z.uuid(), name: z.string().nullable() }).nullable(),
});
/** The validated shape of `CostRecordRow`, as the api and web see it after parsing. */
export type CostRecordRow = z.infer<typeof CostRecordRow>;

/** One page of `GET /api/styles/:id/cost-records`; pass `nextCursor` back as `cursor`, null at the end. */
export const CostRecordListResponse = z.object({
  items: z.array(CostRecordRow),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `CostRecordListResponse`, as the api and web see it after parsing. */
export type CostRecordListResponse = z.infer<typeof CostRecordListResponse>;

/** An optional free text, trimmed, at most `max` characters; blank counts as absent. */
const OptionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((text) => text || undefined);

/**
 * Body of `POST /api/styles/:id/cost-records` (spec 0012, AC-13; `catalog.edit` and
 * `cost.view`): a cost record for the style, or for one of its variants as an override
 * (`variantId`; a variant outside the style answers 404 `NOT_FOUND`). `seasonId` is required and
 * may name any season, an archived one too; `unitCost` is 0 to 9,999,999,999.9999 with at most 4
 * decimals, typed in any digit set; `effectiveFrom` is any `YYYY-MM-DD` date; `source` is at most
 * 200 characters. `reason` (at most 500) is required when `effectiveFrom` is before today's
 * operating day (422 `REASON_REQUIRED`). A bad body answers 422 `INVALID_INPUT`.
 */
export const RecordCostRequest = z
  .object({
    variantId: CatalogId.optional(),
    seasonId: CatalogId,
    costBasis: CostBasis,
    unitCost: moneyInput(4).pipe(UnitCostString),
    effectiveFrom: z.iso.date().refine((day) => day >= '0001-01-01', {
      message: 'A date from year 0001',
    }),
    source: OptionalText(200),
    reason: OptionalText(500),
  })
  .strict();
/** What a caller passes for `RecordCostRequest`, before defaults and transforms are applied. */
export type RecordCostRequest = z.input<typeof RecordCostRequest>;

/** One variant of the style with its cost in force today, in the answer of a new record. */
export const StyleVariantCost = z.object({
  id: z.uuid(),
  code: z.string(),
  cost: VariantCost,
});
/** The validated shape of `StyleVariantCost`, as the api and web see it after parsing. */
export type StyleVariantCost = z.infer<typeof StyleVariantCost>;

/**
 * Answer of `POST /api/styles/:id/cost-records` (201): the new record and every variant of the
 * style (code order, archived ones included) with its cost in force on today's operating day.
 */
export const RecordCostResponse = z.object({
  record: CostRecordRow,
  variants: z.array(StyleVariantCost),
});
/** The validated shape of `RecordCostResponse`, as the api and web see it after parsing. */
export type RecordCostResponse = z.infer<typeof RecordCostResponse>;
