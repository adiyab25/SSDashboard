import { z } from 'zod';
import { LocalizedText } from './localized-text.js';

/** Query of `GET /api/locations`. `cursor` is the previous page's `nextCursor`. */
export const LocationListQuery = z.object({
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

/** Active warehouses and showrooms ordered by code, a page at a time. */
export const LocationListResponse = z.object({
  items: z.array(LocationSummary),
  nextCursor: z.string().nullable(),
});

export type LocationListResponse = z.infer<typeof LocationListResponse>;
