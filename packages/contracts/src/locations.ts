import { z } from 'zod';
import { LocalizedText } from './localized-text.js';

export const LocationStatus = z.enum(['active', 'archived']);
export type LocationStatus = z.infer<typeof LocationStatus>;

/**
 * Query of `GET /api/locations`. `cursor` is the previous page's `nextCursor`. `status=archived`
 * is admin only (403 `FORBIDDEN` for staff).
 */
export const LocationListQuery = z.object({
  status: LocationStatus.default('active'),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});

export type LocationListQuery = z.infer<typeof LocationListQuery>;

/** The places a person works in: warehouses and showrooms, never transit or virtual ones. */
export const WorkLocationType = z.enum(['warehouse', 'showroom']);

export const LocationSummary = z.object({
  id: z.uuid(),
  code: z.string(),
  name: LocalizedText,
  type: WorkLocationType,
});

export type LocationSummary = z.infer<typeof LocationSummary>;

/** Location codes are trimmed and uppercased before the pattern check (spec 0006, AC-4). */
export const LocationCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9._-]{1,16}$/, 'Letters, digits, dot, dash, and underscore, up to 16');

const LocationNameText = z.string().trim().min(1).max(200);

/** A location name in English and/or Arabic: at least one language. Empty strings count as absent. */
export const LocationName = z
  .object({
    en: LocationNameText.optional().or(z.literal('').transform(() => undefined)),
    ar: LocationNameText.optional().or(z.literal('').transform(() => undefined)),
  })
  .refine((name) => name.en !== undefined || name.ar !== undefined, {
    message: 'Give a name in at least one language',
    path: ['en'],
  });

/** `POST /api/locations` (admin). */
export const CreateLocationRequest = z
  .object({ code: LocationCode, name: LocationName, type: WorkLocationType })
  .strict();
export type CreateLocationRequest = z.input<typeof CreateLocationRequest>;

/** One location as the list and the management endpoints return it. */
export const LocationDetail = LocationSummary.extend({
  archived: z.boolean(),
  /** The microsecond UTC string the stale check compares. */
  updatedAt: z.string(),
  /** True once stock was posted or a receipt was recorded there: the code is read only. */
  codeLocked: z.boolean(),
});
export type LocationDetail = z.infer<typeof LocationDetail>;

/** Warehouses and showrooms ordered by code, a page at a time. Never transit or virtual. */
export const LocationListResponse = z.object({
  items: z.array(LocationDetail),
  nextCursor: z.string().nullable(),
});

export type LocationListResponse = z.infer<typeof LocationListResponse>;

/**
 * `PATCH /api/locations/:id` (admin). Absent fields are left as is. A code change answers 409
 * `CODE_LOCKED` once `codeLocked` is true; a stale `updatedAt` answers 409 `STALE_RECORD`.
 */
export const UpdateLocationRequest = z
  .object({
    updatedAt: z.string().min(1).max(40),
    code: LocationCode.optional(),
    name: LocationName.optional(),
    type: WorkLocationType.optional(),
  })
  .strict();
export type UpdateLocationRequest = z.input<typeof UpdateLocationRequest>;
