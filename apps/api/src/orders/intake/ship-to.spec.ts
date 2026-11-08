import { describe, expect, it } from 'vitest';
import { InvalidPhoneAlt } from '../orders.errors.js';
import { parsePhones } from './ship-to.js';

describe('parsePhones', () => {
  it('normalizes the main and second phone, in Arabic or Western digits', () => {
    const phones = parsePhones('٠١٠٠١٢٣٤٥٦٧', '+20 100 765 4321');

    expect(phones.main?.e164).toBe('+201001234567');
    expect(phones.mainRaw).toBeNull();
    expect(phones.alt).toBe('+201007654321');
  });

  it('keeps a main phone that does not parse as typed and gives no number', () => {
    const phones = parsePhones('01x 2345', null);

    expect(phones.main).toBeNull();
    expect(phones.mainRaw).toBe('01x 2345');
    expect(phones.alt).toBeNull();
  });

  it('refuses a second phone that does not parse, without echoing it', () => {
    let error: unknown = null;
    try {
      parsePhones('01001234567', '12 34');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(InvalidPhoneAlt);
    expect((error as Error).message).not.toContain('12 34');
  });
});
