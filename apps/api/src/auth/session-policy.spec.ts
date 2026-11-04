import { describe, expect, it } from 'vitest';
import { pastAbsoluteCap, SESSION_ABSOLUTE_MS } from './session-policy.js';

const NOW = new Date('2026-11-10T12:00:00Z');

describe('pastAbsoluteCap', () => {
  it('is false just under 7 days and true at 7 days', () => {
    expect(pastAbsoluteCap(new Date(NOW.getTime() - SESSION_ABSOLUTE_MS + 1), NOW)).toBe(false);
    expect(pastAbsoluteCap(new Date(NOW.getTime() - SESSION_ABSOLUTE_MS), NOW)).toBe(true);
  });

  it('reads a date string the way the database returns it', () => {
    expect(pastAbsoluteCap('2026-11-01T00:00:00Z', NOW)).toBe(true);
    expect(pastAbsoluteCap('2026-11-09T00:00:00Z', NOW)).toBe(false);
  });

  it('fails closed on a date it cannot read', () => {
    expect(pastAbsoluteCap('not a date', NOW)).toBe(true);
  });
});
