import { describe, expect, it } from 'vitest';
import { homeOf, StaffOnlySessionAudiences, type SessionAudience } from './session-audiences.js';

describe('StaffOnlySessionAudiences (spec 0005, AC-28 and AC-29)', () => {
  const audiences = new StaffOnlySessionAudiences();

  it('answers staff, and only staff, for anyone', async () => {
    const first = await audiences.audiencesFor('0190c0de-0000-7000-8000-000000000001');
    const second = await audiences.audiencesFor('0190c0de-0000-7000-8000-000000000002');

    expect([...first]).toEqual(['staff']);
    expect([...second]).toEqual(['staff']);
  });
});

describe('homeOf (AC-28)', () => {
  it.each<[SessionAudience[], string]>([
    [['staff'], 'backoffice'],
    [['partner'], 'partner'],
    [[], 'backoffice'],
  ])('sends %j to %s', (audiences, home) => {
    expect(homeOf(new Set(audiences))).toBe(home);
  });
});
