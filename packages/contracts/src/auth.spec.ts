import { describe, expect, it } from 'vitest';
import { Home, MeResponse, Password, unmetPasswordRules } from './auth.js';

describe('the password rule (AC-8)', () => {
  it.each(['Abcdefg1', 'Correct-Horse-1', `A1${'b'.repeat(126)}`])('accepts %s', (password) => {
    expect(unmetPasswordRules(password)).toEqual([]);
    expect(Password.safeParse(password).success).toBe(true);
  });

  it.each([
    ['', ['min_length', 'lowercase', 'uppercase', 'digit']],
    ['Abc1', ['min_length']],
    ['abcdefg1', ['uppercase']],
    ['ABCDEFG1', ['lowercase']],
    ['Abcdefgh', ['digit']],
    [`A1${'b'.repeat(127)}`, ['max_length']],
  ] as const)('names every rule %j breaks', (password, unmet) => {
    expect(unmetPasswordRules(password)).toEqual(unmet);
    expect(Password.safeParse(password).success).toBe(false);
  });

  it.each([
    ['Arabic-Indic', 'Abcdefg\u0663'],
    ['Extended Arabic-Indic', 'Abcdefg\u06f3'],
  ])('counts an %s digit as a digit', (_name, password) => {
    expect(unmetPasswordRules(password)).toEqual([]);
    expect(Password.safeParse(password).success).toBe(true);
  });

  it('still asks for a digit when there is none in any script', () => {
    expect(unmetPasswordRules('Abcdefgh')).toEqual(['digit']);
    // Arabic letters and the Arabic comma are not digits.
    expect(unmetPasswordRules('Abcdefg\u0628\u060c')).toEqual(['digit']);
  });

  it('counts Arabic and other non Latin letters by case where they have one, and requires a digit', () => {
    // Arabic letters have no case, so they cannot satisfy upper or lower on their own.
    expect(unmetPasswordRules('كلمةالسر12')).toEqual(['lowercase', 'uppercase']);
    expect(unmetPasswordRules('Éclair-12')).toEqual([]);
  });
});

describe('MeResponse home (spec 0005, AC-28)', () => {
  const me = {
    id: '0190c0de-0000-7000-8000-000000000001',
    name: 'Sam',
    email: 'sam@example.com',
    hats: ['warehouse'],
    permissions: ['stock.view'],
    partnerAccountId: null,
    phone: null,
    staffCode: null,
    language: null,
    twoFactorEnabled: false,
    mustChangePassword: false,
  };

  it.each(['backoffice', 'partner'])('accepts home %s', (home) => {
    expect(MeResponse.parse({ ...me, home }).home).toBe(home);
  });

  it('refuses an answer without home, or with a home that is not a landing page', () => {
    expect(MeResponse.safeParse(me).success).toBe(false);
    expect(MeResponse.safeParse({ ...me, home: 'portal' }).success).toBe(false);
    expect(Home.options).toEqual(['backoffice', 'partner']);
  });
});

describe('MeResponse access (spec 0008, AC-5 and AC-11)', () => {
  const me = {
    id: '0190c0de-0000-7000-8000-000000000001',
    name: 'Sam',
    email: 'sam@example.com',
    hats: ['warehouse'],
    permissions: ['stock.view'],
    partnerAccountId: null,
    phone: null,
    staffCode: null,
    language: null,
    twoFactorEnabled: false,
    mustChangePassword: false,
    home: 'backoffice',
  };

  it('carries hats, permissions and the partner account, and no role', () => {
    const parsed = MeResponse.parse({ ...me, role: 'admin' });

    expect(parsed).toEqual(me);
    expect('role' in parsed).toBe(false);
  });

  it('refuses an unknown hat or permission', () => {
    expect(MeResponse.safeParse({ ...me, hats: ['owner'] }).success).toBe(false);
    expect(MeResponse.safeParse({ ...me, permissions: ['everything'] }).success).toBe(false);
  });
});
