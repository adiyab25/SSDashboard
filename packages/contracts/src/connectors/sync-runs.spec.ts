import { describe, expect, it } from 'vitest';
import {
  BackfillBody,
  SyncRunErrorCode,
  SyncRunListQuery,
  SyncRunListResponse,
} from './sync-runs.js';

// Spec 0015 task 12 (*API surface*): the gateway scan, backfill, and sync runs routes' shapes.
describe('the sync run contracts', () => {
  it('takes a go live instant and nothing else', () => {
    expect(BackfillBody.parse({ goLiveAt: '2026-11-05T08:00:00Z' })).toEqual({
      goLiveAt: '2026-11-05T08:00:00Z',
    });
    expect(BackfillBody.safeParse({ goLiveAt: 'tomorrow' }).success).toBe(false);
    expect(BackfillBody.safeParse({ goLiveAt: '2026-11-05T08:00:00Z', extra: 1 }).success).toBe(
      false,
    );
  });

  it('pages 50 runs by default and at most 100, optionally of one kind', () => {
    expect(SyncRunListQuery.parse({})).toEqual({ limit: 50 });
    expect(SyncRunListQuery.parse({ kind: 'gateway_scan', limit: '10' })).toEqual({
      kind: 'gateway_scan',
      limit: 10,
    });
    expect(SyncRunListQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(SyncRunListQuery.safeParse({ kind: 'everything' }).success).toBe(false);
  });

  it('answers counts of numbers, flags, codes, and name lists only', () => {
    const run = {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      kind: 'gateway_scan',
      status: 'succeeded',
      startedAt: '2026-11-05T09:00:00.000000Z',
      finishedAt: '2026-11-05T09:01:00.000000Z',
      watermarkFrom: null,
      watermarkTo: null,
      counts: {
        orders: 3,
        gatewayNames: ['Cash on Delivery (COD)'],
        since: '2026-09-06T09:00:00Z',
      },
      costPoints: 21,
      errorCode: null,
    };
    expect(SyncRunListResponse.parse({ items: [run], nextCursor: null }).items).toHaveLength(1);
    expect(
      SyncRunListResponse.safeParse({
        items: [{ ...run, counts: { nested: { url: 'x' } } }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it('lists the error codes of the routes, the F1 codes appended after the first ones', () => {
    expect(SyncRunErrorCode.options).toEqual([
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
  });
});
