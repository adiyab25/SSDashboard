import { describe, expect, it } from 'vitest';
import { directionOf } from './rtl.js';

describe('directionOf', () => {
  // AC-2: direction follows the language.
  it('reads right to left for the right to left base codes and left to right otherwise', () => {
    for (const code of ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb']) {
      expect(directionOf(code), code).toBe('rtl');
    }
    for (const code of ['en', 'fr', 'de', 'tr']) {
      expect(directionOf(code), code).toBe('ltr');
    }
  });
});
