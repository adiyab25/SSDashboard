import { describe, expect, it } from 'vitest';
import { recordTypeLabelKey } from './audit-labels';

describe('recordTypeLabelKey', () => {
  it('labels a person and a stock receipt', () => {
    expect(recordTypeLabelKey('user')).toBe('audit.recordTypes.user');
    expect(recordTypeLabelKey('stock_receipt')).toBe('audit.recordTypes.stockReceipt');
  });

  it('knows nothing of an unknown type', () => {
    expect(recordTypeLabelKey('nope')).toBeUndefined();
  });
});
