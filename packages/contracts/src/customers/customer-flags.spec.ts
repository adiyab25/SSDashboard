import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_FLAG_NOTE_MAX,
  CustomerClearFlagRequest,
  CustomerSetFlagRequest,
} from './customer-flags.js';

const stamp = '2026-11-09T10:00:00.123456Z';

describe('CustomerSetFlagRequest', () => {
  it('strips invisible format characters from the note, then trims it', () => {
    const parsed = CustomerSetFlagRequest.parse({
      kind: 'refuser',
      note: '‮  Refused ​twice⁦⁩  ‬',
      expectedUpdatedAt: stamp,
    });

    expect(parsed.note).toBe('Refused twice');
  });

  it('checks the cap after cleaning, so padding and marks do not count', () => {
    const kept = 'a'.repeat(CUSTOMER_FLAG_NOTE_MAX);
    const padded = CustomerSetFlagRequest.safeParse({
      kind: 'fake',
      note: `   ${kept}‏‎   `,
      expectedUpdatedAt: stamp,
    });
    const long = CustomerSetFlagRequest.safeParse({
      kind: 'fake',
      note: `${kept}b`,
      expectedUpdatedAt: stamp,
    });

    expect(padded.success && padded.data.note).toBe(kept);
    expect(long.success).toBe(false);
    expect(long.error?.issues.map((issue) => [issue.path.join('.'), issue.code])).toEqual([
      ['note', 'too_big'],
    ]);
  });

  it('refuses a stamp before 1970 on both flag bodies, and keeps an issued one', () => {
    for (const early of ['0000-01-01T00:00:00Z', '1969-12-31T23:59:59.999999Z']) {
      expect(
        CustomerSetFlagRequest.safeParse({ kind: 'fake', expectedUpdatedAt: early }).success,
      ).toBe(false);
      expect(
        CustomerClearFlagRequest.safeParse({
          reasonCode: 'flag_mistaken',
          expectedUpdatedAt: early,
        }).success,
      ).toBe(false);
    }
    expect(
      CustomerClearFlagRequest.safeParse({ reasonCode: 'flag_mistaken', expectedUpdatedAt: stamp })
        .success,
    ).toBe(true);
    expect(
      CustomerSetFlagRequest.safeParse({ kind: 'fake', expectedUpdatedAt: '1970-01-01T00:00:00Z' })
        .success,
    ).toBe(true);
  });
});
