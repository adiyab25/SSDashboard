import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_FLAG_NOTE_MAX,
  CustomerClearFlagRequest,
  CustomerSetFlagRequest,
  CustomerSetFlagResponse,
} from '../src/index.js';

const at = '2026-11-08T10:00:00.123456Z';

// Spec 0014 AC-11: the flag set and clear bodies.
describe('CustomerSetFlagRequest', () => {
  it('takes a kind with an optional note and reason code', () => {
    expect(CustomerSetFlagRequest.parse({ kind: 'refuser', expectedUpdatedAt: at })).toEqual({
      kind: 'refuser',
      expectedUpdatedAt: at,
    });
    expect(
      CustomerSetFlagRequest.parse({
        kind: 'fake',
        note: null,
        reasonCode: 'confirmed_fake',
        expectedUpdatedAt: at,
      }).note,
    ).toBeNull();
  });

  it('caps the note at 500 characters', () => {
    const body = { kind: 'returner', expectedUpdatedAt: at };
    expect(CUSTOMER_FLAG_NOTE_MAX).toBe(500);
    expect(CustomerSetFlagRequest.safeParse({ ...body, note: 'x'.repeat(500) }).success).toBe(true);
    expect(CustomerSetFlagRequest.safeParse({ ...body, note: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });

  it('refuses an unknown kind, an unlisted reason code, extra keys, and a missing stamp', () => {
    expect(CustomerSetFlagRequest.safeParse({ kind: 'vip', expectedUpdatedAt: at }).success).toBe(
      false,
    );
    expect(
      CustomerSetFlagRequest.safeParse({
        kind: 'refuser',
        reasonCode: 'flag_mistaken',
        expectedUpdatedAt: at,
      }).success,
    ).toBe(false);
    expect(
      CustomerSetFlagRequest.safeParse({ kind: 'refuser', expectedUpdatedAt: at, x: 1 }).success,
    ).toBe(false);
    expect(CustomerSetFlagRequest.safeParse({ kind: 'refuser' }).success).toBe(false);
  });

  it('answers the flag block and the new stamp', () => {
    const answer = {
      flag: { kind: 'refuser', source: 'manual', note: null, setAt: at, setByName: 'Mona' },
      updatedAt: at,
    };
    expect(CustomerSetFlagResponse.parse(answer)).toEqual(answer);
  });
});

describe('CustomerClearFlagRequest', () => {
  it('requires one of the unflag reason codes', () => {
    expect(
      CustomerClearFlagRequest.safeParse({ reasonCode: 'flag_mistaken', expectedUpdatedAt: at })
        .success,
    ).toBe(true);
    expect(CustomerClearFlagRequest.safeParse({ expectedUpdatedAt: at }).success).toBe(false);
    expect(
      CustomerClearFlagRequest.safeParse({ reasonCode: 'confirmed_fake', expectedUpdatedAt: at })
        .success,
    ).toBe(false);
  });
});
