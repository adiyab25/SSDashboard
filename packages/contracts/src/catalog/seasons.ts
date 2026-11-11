import { z } from 'zod';
import { LocalizedText } from '../localized-text.js';
import { SkuName, UpdatedAt } from './skus.js';

/**
 * A stored season or product group code (spec 0012, AC-6, AC-7): upper case letters, digits,
 * dot, dash, and underscore, up to 16. Also the audit label shape of both record types.
 */
export const GROUPING_CODE_PATTERN = /^[A-Z0-9._-]{1,16}$/;

/** Season and product group codes are trimmed and uppercased before the pattern check. */
export const GroupingCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GROUPING_CODE_PATTERN, 'Letters, digits, dot, dash, and underscore, up to 16');

/**
 * Which rows a season or product group list shows: `active` (the default, what pickers and
 * filters offer), `archived`, or `all` (a filter that must still name an archived one).
 */
export const GroupingListStatus = z.enum(['active', 'archived', 'all']);
/** The validated shape of `GroupingListStatus`, as the api and web see it after parsing. */
export type GroupingListStatus = z.infer<typeof GroupingListStatus>;

/**
 * Query of `GET /api/seasons` and `GET /api/product-groups` (spec 0012, API surface): `q`
 * matches a code prefix or a fragment of either name (after `ssd_search_normalize`), ordered and
 * paged by code (`COLLATE "C"`, keyset), at most 100 per page.
 */
export const GroupingListQuery = z.object({
  status: GroupingListStatus.default('active'),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
/** The validated shape of `GroupingListQuery`, as the api and web see it after parsing. */
export type GroupingListQuery = z.infer<typeof GroupingListQuery>;

/** A calendar date as `YYYY-MM-DD`, from year 0001 (what PostgreSQL `date` holds). */
const CalendarDate = z.iso.date().refine((day) => day >= '0001-01-01', {
  message: 'A date from year 0001',
});

/**
 * One season (spec 0012, AC-6). `protected` is true for the seeded `CORE` season, which can be
 * renamed but never archived, deleted, or recoded (409 `SEASON_PROTECTED`). `updatedAt` is the
 * microsecond UTC string the stale check compares.
 */
export const Season = z.object({
  id: z.uuid(),
  code: z.string(),
  name: LocalizedText,
  startsOn: z.string().nullable(),
  endsOn: z.string().nullable(),
  archived: z.boolean(),
  protected: z.boolean(),
  updatedAt: z.string(),
});
/** The validated shape of `Season`, as the api and web see it after parsing. */
export type Season = z.infer<typeof Season>;

/** One page of `GET /api/seasons`; pass `nextCursor` back as `cursor`, null at the end. */
export const SeasonListResponse = z.object({
  items: z.array(Season),
  nextCursor: z.string().nullable(),
});
/** The validated shape of `SeasonListResponse`, as the api and web see it after parsing. */
export type SeasonListResponse = z.infer<typeof SeasonListResponse>;

const datesInOrder = (season: { startsOn?: string | null; endsOn?: string | null }) =>
  !season.startsOn || !season.endsOn || season.startsOn <= season.endsOn;

/**
 * `POST /api/seasons` (`catalog.manage`): a unique code (409 `SEASON_CODE_TAKEN`), a name in at
 * least one language, and optional dates in order (422 `INVALID_INPUT`).
 */
export const CreateSeasonRequest = z
  .object({
    code: GroupingCode,
    name: SkuName,
    startsOn: CalendarDate.nullable().optional(),
    endsOn: CalendarDate.nullable().optional(),
  })
  .strict()
  .refine(datesInOrder, { message: 'The end date is before the start date', path: ['endsOn'] });
/** What a caller passes for `CreateSeasonRequest`, before defaults and transforms are applied. */
export type CreateSeasonRequest = z.input<typeof CreateSeasonRequest>;

/**
 * `PATCH /api/seasons/:id` (`catalog.manage`). Absent fields are left as is; a date sent as null
 * is cleared; `name`, when sent, replaces both languages. A stale `updatedAt` answers 409
 * `STALE_RECORD`; dates out of order with the stored ones 422 `INVALID_INPUT`; a new code for
 * `CORE` 409 `SEASON_PROTECTED`.
 */
export const UpdateSeasonRequest = z
  .object({
    updatedAt: UpdatedAt,
    code: GroupingCode.optional(),
    name: SkuName.optional(),
    startsOn: CalendarDate.nullable().optional(),
    endsOn: CalendarDate.nullable().optional(),
  })
  .strict()
  .refine(datesInOrder, { message: 'The end date is before the start date', path: ['endsOn'] });
/** What a caller passes for `UpdateSeasonRequest`, before defaults and transforms are applied. */
export type UpdateSeasonRequest = z.input<typeof UpdateSeasonRequest>;
