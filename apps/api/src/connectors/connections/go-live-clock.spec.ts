import { describe, expect, it } from 'vitest';
import { firstPosition } from '../sync-runs/sync-runs.js';
import { resumePositionOf } from './connections.service.js';
import { goLiveInRange } from './go-live-clock.js';

// Lead decision D11 (spec 0015 task 12, F1): the go live window around the database clock and
// where a failed or stalled backfill resumes. Pure.

const NOW = new Date('2026-11-09T12:00:00.000Z');

describe('goLiveInRange (D11, security review M1)', () => {
  it('takes an instant up to 5 minutes ahead and 60 days back of the database clock', () => {
    expect(goLiveInRange('2026-11-09T12:05:00Z', NOW)).toBe(true);
    expect(goLiveInRange('2026-09-10T12:00:00Z', NOW)).toBe(true);
    expect(goLiveInRange('2026-11-09T12:05:00.001Z', NOW)).toBe(false);
    expect(goLiveInRange('2026-09-10T11:59:59.999Z', NOW)).toBe(false);
    expect(goLiveInRange('2027-11-09T12:00:00Z', NOW)).toBe(false);
    expect(goLiveInRange('not an instant', NOW)).toBe(false);
  });
});

describe('resumePositionOf (D11, AC-17)', () => {
  const at = { ...firstPosition(), step: 4, bulkId: 'gid://shopify/BulkOperation/1', line: 7 };

  it('resumes a run at its recorded line with the step moved on', () => {
    expect(resumePositionOf({ position: at, errorCode: 'CONNECTION_NOT_LIVE' })).toEqual({
      ...at,
      step: 5,
    });
    expect(resumePositionOf({ position: at, errorCode: null })).toMatchObject({ step: 5, line: 7 });
  });

  it('starts a new bulk read when Shopify ended the operation or refused its address, or its file was too large', () => {
    for (const code of [
      'BULK_OPERATION_FAILED',
      'BULK_EXPIRED',
      'REQUEST_REJECTED',
      'RESPONSE_TOO_LARGE',
    ]) {
      expect(resumePositionOf({ position: at, errorCode: code })).toMatchObject({
        step: 5,
        bulkId: null,
        line: 0,
      });
    }
  });

  it('keeps a paged run on its page cursor', () => {
    const paged = { ...firstPosition(), step: 2, mode: 'paged' as const, after: 'cursor-9' };
    expect(resumePositionOf({ position: paged, errorCode: 'BULK_EXPIRED' })).toMatchObject({
      step: 3,
      mode: 'paged',
      after: 'cursor-9',
    });
  });
});
