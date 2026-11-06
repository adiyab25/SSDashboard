import { describe, expect, it } from 'vitest';
import {
  InvalidMatchChain,
  lineMatchState,
  settlementPeriodStatus,
  type SettlementLineMatchRow,
  type SettlementPeriodEventRow,
} from '../src/index.js';

const match = (
  id: string,
  supersedesMatchId: string | null,
  result: SettlementLineMatchRow['result'],
  reasonCode: string | null = null,
): SettlementLineMatchRow => ({ id, supersedesMatchId, result, reasonCode });

const event = (
  id: string,
  at: string,
  action: SettlementPeriodEventRow['action'],
): SettlementPeriodEventRow => ({ id, recordedAt: at, action });

describe('lineMatchState', () => {
  it('is unmatched with not_yet_matched when a line has no match rows', () => {
    expect(lineMatchState([])).toEqual({
      result: 'unmatched',
      reasonCode: 'not_yet_matched',
      terminal: false,
      settled: false,
      latestMatchId: null,
    });
  });

  it('treats accounted as terminal and settled', () => {
    const state = lineMatchState([match('a', null, 'accounted')]);
    expect(state).toMatchObject({ result: 'accounted', terminal: true, settled: true });
  });

  it('treats cleared as terminal and settled, keeping its reason', () => {
    const state = lineMatchState([match('a', null, 'cleared', 'superseded')]);
    expect(state).toMatchObject({
      result: 'cleared',
      reasonCode: 'superseded',
      terminal: true,
      settled: true,
    });
  });

  it('treats matched as settled but not terminal', () => {
    const state = lineMatchState([match('a', null, 'matched')]);
    expect(state).toMatchObject({ result: 'matched', terminal: false, settled: true });
  });

  it('follows the chain: match, unmatch, match leaves the third row as the head', () => {
    const rows = [
      match('a', null, 'matched'),
      match('b', 'a', 'unmatched', 'amount_differs'),
      match('c', 'b', 'matched'),
    ];
    expect(lineMatchState(rows)).toMatchObject({ result: 'matched', latestMatchId: 'c' });
    // Row order does not matter, and ids that sort the other way do not matter either.
    expect(lineMatchState([rows[2]!, rows[0]!, rows[1]!]).latestMatchId).toBe('c');
    expect(
      lineMatchState([match('z', null, 'matched'), match('a', 'z', 'unmatched', 'x')]),
    ).toMatchObject({ result: 'unmatched', reasonCode: 'x', latestMatchId: 'a' });
    expect(lineMatchState(rows.slice(0, 2))).toMatchObject({
      result: 'unmatched',
      reasonCode: 'amount_differs',
      settled: false,
    });
  });

  it('ends at an accounted head', () => {
    const rows = [match('a', null, 'unmatched', 'not_yet_matched'), match('b', 'a', 'accounted')];
    expect(lineMatchState(rows)).toMatchObject({ result: 'accounted', terminal: true });
  });

  it('ends an accounted line as cleared by the superseded clear (D1)', () => {
    const rows = [match('a', null, 'accounted'), match('b', 'a', 'cleared', 'superseded')];
    expect(lineMatchState(rows)).toMatchObject({
      result: 'cleared',
      reasonCode: 'superseded',
      terminal: true,
      settled: true,
      latestMatchId: 'b',
    });
  });

  it.each([
    ['a rematch', match('b', 'a', 'matched')],
    ['another account code', match('b', 'a', 'accounted')],
    ['an unmatch', match('b', 'a', 'unmatched', 'accounted_in_error')],
    ['a clear with another reason', match('b', 'a', 'cleared', 'accounted_in_error')],
  ])('throws on %s after an accounted row (D1, the database refuses it too)', (_case, row) => {
    expect(() => lineMatchState([match('a', null, 'accounted'), row])).toThrow(InvalidMatchChain);
  });

  // Review R17: a cleared line belongs to a superseded statement, so nothing follows it.
  it.each([
    ['an accounting', match('c', 'b', 'accounted')],
    ['a rematch', match('c', 'b', 'matched')],
    ['another clear', match('c', 'b', 'cleared', 'superseded')],
  ])('throws on %s after a cleared row (R17, the database refuses it too)', (_case, row) => {
    const chain = [match('a', null, 'accounted'), match('b', 'a', 'cleared', 'superseded'), row];
    expect(() => lineMatchState(chain)).toThrow(InvalidMatchChain);
  });

  it('throws when two rows are heads (a corrupt chain)', () => {
    expect(() =>
      lineMatchState([match('a', null, 'matched'), match('b', null, 'matched')]),
    ).toThrow(InvalidMatchChain);
    expect(() =>
      lineMatchState([
        match('a', null, 'matched'),
        match('b', 'a', 'matched'),
        match('c', 'a', 'matched'),
      ]),
    ).toThrow(InvalidMatchChain);
  });

  it('throws when no row is a head (a cycle)', () => {
    expect(() => lineMatchState([match('a', 'b', 'matched'), match('b', 'a', 'matched')])).toThrow(
      InvalidMatchChain,
    );
  });

  it('carries a typed code on the error', () => {
    try {
      lineMatchState([match('a', null, 'matched'), match('b', null, 'matched')]);
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidMatchChain).code).toBe('InvalidMatchChain');
    }
  });
});

describe('settlementPeriodStatus', () => {
  it('is open with no events', () => {
    expect(settlementPeriodStatus([])).toBe('open');
  });

  it('is closed after a close and open after a revoke', () => {
    expect(settlementPeriodStatus([event('a', '2026-11-01T10:00:00Z', 'closed')])).toBe('closed');
    expect(
      settlementPeriodStatus([
        event('a', '2026-11-01T10:00:00Z', 'closed'),
        event('b', '2026-11-02T10:00:00Z', 'revoked'),
      ]),
    ).toBe('open');
  });

  it('follows close, revoke, close to closed', () => {
    const events = [
      event('c', '2026-11-03T10:00:00Z', 'closed'),
      event('a', '2026-11-01T10:00:00Z', 'closed'),
      event('b', '2026-11-02T10:00:00Z', 'revoked'),
    ];
    expect(settlementPeriodStatus(events)).toBe('closed');
  });

  it('breaks a recorded_at tie by the greater id (uuidv7 grows within a session)', () => {
    expect(
      settlementPeriodStatus([
        event('a', '2026-11-01T10:00:00Z', 'closed'),
        event('b', '2026-11-01T10:00:00Z', 'revoked'),
      ]),
    ).toBe('open');
    expect(
      settlementPeriodStatus([
        event('b', '2026-11-01T10:00:00Z', 'revoked'),
        event('a', '2026-11-01T10:00:00Z', 'closed'),
      ]),
    ).toBe('open');
  });
});
