import { describe, expect, it } from 'vitest';
import { rowStripeClassName } from './row-stripe';
import { STATUS_MEANINGS } from './status-meaning';

describe('rowStripeClassName', () => {
  it.each(STATUS_MEANINGS)('returns a logical start edge for %s', (meaning) => {
    const classes = rowStripeClassName(meaning);

    expect(classes).toContain('border-s-4');
    expect(classes).not.toMatch(/border-(l|r)-/);
  });

  it('is dashed only for provisional', () => {
    expect(rowStripeClassName('provisional')).toContain('border-dashed');
    expect(rowStripeClassName('confirmed')).not.toContain('border-dashed');
  });
});
