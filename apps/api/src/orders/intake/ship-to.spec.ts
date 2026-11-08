import { describe, expect, it } from 'vitest';
import { InvalidPhoneAlt } from '../orders.errors.js';
import { parseChannelPhones, parsePhones } from './ship-to.js';

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

describe('parseChannelPhones (spec 0013 AC-14, review N4)', () => {
  it('keeps a main phone that does not parse as typed and drops a second one that does not', () => {
    const phones = parseChannelPhones('01x 2345', '12 34');

    expect(phones).toEqual({ main: null, mainRaw: '01x 2345', alt: null, altUnparseable: true });
  });

  it('parses good phones and reports nothing', () => {
    const phones = parseChannelPhones('01001234567', '01007654321');

    expect(phones.main?.e164).toBe('+201001234567');
    expect(phones.alt).toBe('+201007654321');
    expect(phones.altUnparseable).toBe(false);
  });

  it('has no phone and no raw text when the channel sent none', () => {
    expect(parseChannelPhones(null, null)).toEqual({
      main: null,
      mainRaw: null,
      alt: null,
      altUnparseable: false,
    });
    expect(parseChannelPhones('', '').mainRaw).toBeNull();
  });
});
