import { z } from 'zod';
import { SyncRunKind, SyncRunStatus } from './connector-enums.js';

/**
 * The sync run routes' shapes (spec 0015 task 12, *API surface*): the gateway scan and backfill
 * starts and the list of a connection's runs. A run's counts hold numbers, codes, and gateway names
 * only: never a customer's data, a credential, a bulk result address, or provider text.
 */

/** A UTC instant as the api issues it (microseconds, `Z`). */
const Instant = z.iso.datetime({ offset: true });

/**
 * `POST /api/connections/:id/backfill` (`settings.manage`, AC-17): the go live instant. Open
 * orders placed before it enter `confirmed` (`go_live_import`), later ones as live `new` orders,
 * closed ones with their found states. It is set once, by the first start (lead decision D11): a
 * later call with the same instant resumes or redoes the backfill, another instant is refused. Feature 15's default (the online location's verified
 * opening count) is filled by the screen, not here.
 */
export const BackfillBody = z.strictObject({
  goLiveAt: Instant,
});
/** The parsed BackfillBody. */
export type BackfillBody = z.infer<typeof BackfillBody>;

/**
 * The 202 answer of `POST /api/connections/:id/gateway-scan` and `/backfill`: the run that was
 * started (for a backfill, its products run; the orders run follows it, listed by
 * `GET /api/connections/:id/sync-runs`).
 */
export const SyncRunStarted = z.object({
  runId: z.uuid(),
});
/** The parsed SyncRunStarted. */
export type SyncRunStarted = z.infer<typeof SyncRunStarted>;

/**
 * The stable error codes of the task 12 routes: 409 `SCAN_RUNNING` (a gateway scan of the
 * connection has not finished), `BACKFILL_RUNNING` (a backfill run has not finished),
 * `CONNECTION_NOT_READY` (the connection is not active, or its health is not `ok` or `degraded`),
 * `GATEWAYS_UNMAPPED` (no gateway scan finished yet, or a scanned gateway name has no payment
 * method in the connection's `gatewayMethods`); 404 `NOT_FOUND`; 422 `INVALID_BODY`; 400
 * `INVALID_QUERY` for a bad list query or cursor. Appended by lead decision D11 and the F1 fixes:
 * 409 `GO_LIVE_ALREADY_SET` (a backfill with another go live instant than the one set), 422
 * `GO_LIVE_OUT_OF_RANGE` (a first go live instant after the database clock plus 5 minutes or
 * before it minus 60 days), 409 `CONNECTION_PAUSED` (a scan or backfill of a paused connection),
 * and 409 `GATEWAYS_TOO_MANY` (the newest gateway scan found more than 100 names).
 */
export const SyncRunErrorCode = z.enum([
  'SCAN_RUNNING',
  'BACKFILL_RUNNING',
  'CONNECTION_NOT_READY',
  'GATEWAYS_UNMAPPED',
  'NOT_FOUND',
  'INVALID_BODY',
  'INVALID_QUERY',
  'GO_LIVE_ALREADY_SET',
  'GO_LIVE_OUT_OF_RANGE',
  'CONNECTION_PAUSED',
  'GATEWAYS_TOO_MANY',
]);
/** One SyncRunErrorCode value. */
export type SyncRunErrorCode = z.infer<typeof SyncRunErrorCode>;

/** `GET /api/connections/:id/sync-runs` query: an optional kind, a keyset cursor, a page size. */
export const SyncRunListQuery = z.object({
  kind: SyncRunKind.optional(),
  cursor: z.string().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
/** The parsed SyncRunListQuery. */
export type SyncRunListQuery = z.infer<typeof SyncRunListQuery>;

/** One value a run's counts may hold: a number, a flag, a code, or a list of names. */
const CountValue = z.union([z.number(), z.boolean(), z.string(), z.array(z.string()), z.null()]);

/**
 * One sync run of a connection (`connection_sync_runs`): its kind and status, when it started and
 * finished, the watermark window a sweep read, its counts (by kind: a sweep's `found`, `recorded`,
 * `retried`, `resent`; a backfill's `objects`, `recorded`, `lines`, `mode`; a gateway scan's
 * `orders` and `gatewayNames`; an hourly check's `missingScopes`, `webhookTopicsSubscribed`,
 * `webhookTopicsCreated`; a connect check's own), the Shopify cost points it spent, and its error
 * code. The run's internal resume position is never answered.
 */
export const SyncRunView = z.object({
  id: z.uuid(),
  kind: SyncRunKind,
  status: SyncRunStatus,
  startedAt: Instant,
  finishedAt: Instant.nullable(),
  watermarkFrom: Instant.nullable(),
  watermarkTo: Instant.nullable(),
  counts: z.record(z.string(), CountValue),
  costPoints: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
});
/** The parsed SyncRunView. */
export type SyncRunView = z.infer<typeof SyncRunView>;

/** `GET /api/connections/:id/sync-runs`: one page, newest first, and the next page's cursor. */
export const SyncRunListResponse = z.object({
  items: z.array(SyncRunView),
  nextCursor: z.string().nullable(),
});
/** The parsed SyncRunListResponse. */
export type SyncRunListResponse = z.infer<typeof SyncRunListResponse>;
