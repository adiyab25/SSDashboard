import { describe, expect, it } from 'vitest';
import { cleanCustomerName } from './find-or-create.js';

describe('cleanCustomerName', () => {
  it('strips direction marks, isolates and zero width characters, then trims', () => {
    const marked = '‮  Mona‏ Ali⁦⁩​ ‬';

    expect(cleanCustomerName(marked)).toBe('Mona Ali');
    expect(cleanCustomerName('‎منى‏')).toBe('منى');
  });

  it('answers null when nothing is left, and keeps an ordinary name as it is', () => {
    expect(cleanCustomerName(null)).toBeNull();
    expect(cleanCustomerName('   ')).toBeNull();
    expect(cleanCustomerName('‪‫⁦‎')).toBeNull();
    expect(cleanCustomerName('Nadia Hamdy')).toBe('Nadia Hamdy');
  });
});
