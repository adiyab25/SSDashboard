import { describe, expect, it } from 'vitest';
import { flatten, requiredKeys } from './catalog.js';
import { en } from './locales/en.js';
import { ar } from './locales/ar.js';

/** Spec 0003, AC-21: in screen help is text in the catalogs, English and Arabic, under `help.<screen>.*`. */
describe('help text', () => {
  const helpKeys = (keys: readonly string[]) => keys.filter((key) => key.startsWith('help.'));

  it('has help keys for the confirmation queue and the shared help words', () => {
    const keys = helpKeys(Object.keys(flatten(en)));

    expect(keys).toContain('help.common.open');
    expect(keys).toContain('help.confirmationQueue.title');
    expect(keys).toContain('help.confirmationQueue.steps.1');
  });

  it('has every English help key in Arabic, so a missing Arabic help key fails the build', () => {
    const have = new Set(Object.keys(flatten(ar)));

    const missing = helpKeys(requiredKeys('ar-EG')).filter((key) => !have.has(key));

    expect(missing).toEqual([]);
  });

  it('keeps every help message a non empty string in both languages', () => {
    for (const catalog of [en, ar]) {
      const flat = flatten(catalog);
      const empty = helpKeys(Object.keys(flat)).filter((key) => flat[key]?.trim() === '');
      expect(empty).toEqual([]);
    }
  });
});
