import { describe, expect, it } from 'vitest';
import { t } from './t';

describe('t', () => {
  it('returns the English text for a dotted key', () => {
    expect(t('home.status.api')).toBe('API');
  });

  it('rejects a key that does not exist at type check time', () => {
    // @ts-expect-error: not a message key
    t('shell.nope');
  });
});
