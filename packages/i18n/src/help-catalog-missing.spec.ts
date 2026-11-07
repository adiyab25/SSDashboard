import { describe, expect, it } from 'vitest';
import { flatten, requiredKeys } from './catalog.js';
import { ar } from './locales/ar.js';

/**
 * Spec 0003, AC-21: the rule "a missing Arabic help key fails a test" must actually catch a
 * missing key. `help-catalog.spec.ts` runs the rule on the real catalogs, where nothing is
 * missing; this runs the same rule on an Arabic catalog with one help key removed.
 */
describe('the missing Arabic help key rule', () => {
  const helpKeys = (keys: readonly string[]) => keys.filter((key) => key.startsWith('help.'));

  it('reports a help key that the Arabic catalog lacks', () => {
    const flat = { ...flatten(ar) };
    delete flat['help.common.open'];
    const have = new Set(Object.keys(flat));

    const missing = helpKeys(requiredKeys('ar-EG')).filter((key) => !have.has(key));

    expect(missing).toEqual(['help.common.open']);
  });
});
