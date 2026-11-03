import { describe, expect, it } from 'vitest';
import { generateTemporaryPassword } from './temporary-password.js';

describe('generateTemporaryPassword', () => {
  it('makes 16 characters with a lowercase letter, an uppercase letter and a digit (AC-8)', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateTemporaryPassword()).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[A-Za-z\d]{16}$/);
    }
  });

  it('leaves out look alike characters a person would mistype', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateTemporaryPassword()).not.toMatch(/[01OIl]/);
    }
  });

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));

    expect(seen.size).toBe(200);
  });
});
