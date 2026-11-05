import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRedactor,
  DEFAULT_REDACTION_RULES,
  PERSONAL_DATA_KEYS,
  redact,
} from '@ssdashboard/config/redaction';
import { RedactingLogger } from './redacting-logger.js';

/** A fixture order: the customer's personal data, in every shape the rule names. */
const order = {
  id: 'ord_1042',
  total: 1850,
  status: 'placed',
  customer: {
    name: 'Mona Abdelrahman',
    email: 'mona.abdelrahman@example.com',
    phone: '01012345678',
    phones: ['+20 101 234 5678', '٠١٠١٢٣٤٥٦٧٨', '201055566677', '20 109 888 7766'],
    address: {
      line1: '14 Salah Salem Street, Building 3',
      city: 'Nasr City',
      governorate: 'Cairo',
    },
  },
  shippingAddress: { addressLine1: '22 Road 9, Maadi', area: 'Maadi' },
  deliveryAddress: '22 Zamalek Road',
  zone: 'Giza Zone',
  customerPhone: '201055566677',
  note: 'Call 0020-101-234-5678 before delivery',
  items: [{ sku: 'TEE-BLK-M', note: 'gift wrap for Mona' }],
  comment: 'Customer also reachable on ٠١٢٢٣٣٤٤٥٥٦ after 5pm',
  whatsapp: { messageBody: 'Hi, this is Mona, my number is 01198765432' },
};

const LEAKS = [
  'Mona',
  'Abdelrahman',
  'mona.abdelrahman@example.com',
  'Salah Salem',
  'Nasr City',
  'Maadi',
  'Road 9',
  'Cairo',
  '01012345678',
  '101 234 5678',
  '101-234-5678',
  '٠١٠١٢٣٤٥٦٧٨',
  '٠١٢٢٣٣٤٤٥٥٦',
  '01198765432',
  '201055566677',
  '109 888 7766',
  '22 Zamalek Road',
  'Giza Zone',
];

/** Fails showing the leaked text, so a regression is readable in the CI log. */
function expectNoPersonalData(output: string): void {
  const leaked = LEAKS.filter((text) => output.includes(text));
  expect(leaked, `personal data leaked into:\n${output}`).toEqual([]);
  expect(output).not.toMatch(/(?:\+|00)?20?\s*0?1[0125](?:[\s-]*\d){8}/);
  expect(output).not.toMatch(/[٠-٩]{8,}/);
}

describe('personal data redaction (Law 151)', () => {
  let out: string[];
  beforeEach(() => {
    out = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      out.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the list non empty', () => {
    expect(PERSONAL_DATA_KEYS.length).toBeGreaterThan(0);
  });

  it('removes the customer from every level of the real logger, keeping the operational data', () => {
    const logger = new RedactingLogger('Orders');
    logger.log({ event: 'OrderPlaced', order });
    logger.warn(`order ${order.id} for ${order.customer.phone}`);
    logger.error(new Error(`Failed to book ${order.customer.phones[0]}`), undefined, 'Orders');
    logger.debug(order);
    logger.verbose(JSON.stringify(order));
    logger.fatal('stack', order.note);

    const output = out.join('');
    expectNoPersonalData(output);
    expect(output).toContain('ord_1042');
    expect(output).toContain('TEE-BLK-M');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('[phone]');
  });

  it('removes the customer from an error report event (the error tracker hook stand in)', () => {
    const event = {
      message: `Bosta booking failed for ${order.customer.phone}`,
      exception: new Error(`Bosta rejected ${order.customer.phones[1]}`),
      extra: { order },
      breadcrumbs: [{ message: order.note, data: order.customer }],
    };
    const output = JSON.stringify(redact(event));
    expectNoPersonalData(output);
    expect(output).toContain('ord_1042');
  });

  it('does not mutate its input and survives cycles', () => {
    const cyclic: Record<string, unknown> = { id: 1, customer: { phone: '01012345678' } };
    cyclic['self'] = cyclic;
    const copy = redact(cyclic);
    expect((cyclic['customer'] as { phone: string }).phone).toBe('01012345678');
    expect(JSON.stringify(copy)).not.toContain('01012345678');
  });

  it('leaves order numbers, dates and amounts alone', () => {
    for (const text of [
      'order 20261105 id 1700000000000',
      '12-10-2026 15:30',
      'INV-0000123456',
      'amount 12345678.90 EGP',
      '1500000000 piastres',
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it('masks bare country code and keeps the surrounding text', () => {
    expect(redact('call 201012345678 now')).toBe('call [phone] now');
    expect(redact('call 20 101 234 5678.')).toBe('call [phone].');
  });

  it('redacts address fields written as plain strings', () => {
    const output = JSON.stringify(
      redact({
        shippingAddress: '22 Road 9, Maadi',
        billingAddress: 'x1',
        customerAddress: 'x2',
        deliveryAddress: 'x3',
        customerEmail: 'a@b.eg',
        customerPhone: 'x4',
        firstLine: 'x5',
        secondLine: 'x6',
        zone: 'Giza Zone',
        id: 'keep',
      }),
    );
    expect(output).toBe(
      JSON.stringify({
        shippingAddress: '[REDACTED]',
        billingAddress: '[REDACTED]',
        customerAddress: '[REDACTED]',
        deliveryAddress: '[REDACTED]',
        customerEmail: '[REDACTED]',
        customerPhone: '[REDACTED]',
        firstLine: '[REDACTED]',
        secondLine: '[REDACTED]',
        zone: '[REDACTED]',
        id: 'keep',
      }),
    );
  });

  it('keeps an error an error, with its stack and no phone', () => {
    const copy = redact(
      new Error('call 01012345678 now', { cause: new Error('cause 01012345678') }),
    );
    expect(copy).toBeInstanceOf(Error);
    new RedactingLogger('Orders').error(new Error('call 01012345678 now'));
    const output = out.join('');
    expect(output).toMatch(/\n\s+at /);
    expect(output).not.toContain('01012345678');
    expect(output).toContain('[phone]');
  });

  it('never throws on a throwing getter', () => {
    const hostile = {
      id: 'ok',
      get boom(): string {
        throw new Error('nope');
      },
    };
    expect(() => new RedactingLogger('Orders').log(hostile)).not.toThrow();
    expect(JSON.stringify(redact(hostile))).toContain('"boom":"[REDACTED]"');
    expect(out.join('')).toContain('ok');
  });

  it('leaks when the list is emptied (proof the list is what protects)', () => {
    const empty = createRedactor({
      ...DEFAULT_REDACTION_RULES,
      keys: [],
      paths: [],
      contactMarkers: [],
    });
    const output = JSON.stringify(empty(order));
    expect(LEAKS.some((text) => output.includes(text))).toBe(true);
  });
});
