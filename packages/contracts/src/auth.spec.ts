import { describe, expect, it } from 'vitest';
import { Password, unmetPasswordRules } from './auth.js';

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
