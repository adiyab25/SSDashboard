import { describe, expect, it } from 'vitest';
import { orderDetailOf } from './order-detail-fixture';
import { buildEditBody, editDefaultsOf, type OrderEditOutput } from './order-edit-form';

const LINE_ID = '40000000-0000-4000-8000-000000000001';
const VARIANT_M = '50000000-0000-4000-8000-000000000001';
const VARIANT_L = '50000000-0000-4000-8000-000000000002';

/** The form as the defaults of the fixture order hold it, with `lines[0]` changed by `line`. */
function formWith(line: Partial<OrderEditOutput['lines'][number]>): OrderEditOutput {
  const defaults = editDefaultsOf(orderDetailOf());
  const [first] = defaults.lines;
  if (!first) throw new Error('no line');
  return { ...defaults, lines: [{ ...first, ...line }] };
}

const options = { gifted: false, mayChangeLines: true };

describe('buildEditBody (spec 0013, AC-9)', () => {
  it('sends nothing for an untouched form', () => {
    const order = orderDetailOf();
    expect(buildEditBody(order, formWith({}), options).operations).toEqual([]);
  });

  it('skips a replace that names the same SKU, quantity, price, and discount', () => {
    const order = orderDetailOf();
    const body = buildEditBody(order, formWith({ action: 'replace', unitPrice: '250' }), options);
    expect(body.operations).toEqual([]);
  });

  it('sends a replace when the SKU, the quantity, the price, or the discount changed', () => {
    const order = orderDetailOf();
    const sku = { id: VARIANT_L, code: 'TEE-RED-L', name: { en: 'Red tee, L' } };
    const changed = [
      { sku },
      { quantity: '3' },
      { unitPrice: '260.00' },
      { discountAmount: '10.00' },
    ];
    for (const change of changed) {
      const body = buildEditBody(order, formWith({ action: 'replace', ...change }), options);
      expect(body.operations).toHaveLength(1);
      expect(body.operations[0]).toMatchObject({ kind: 'replace_line', lineId: LINE_ID });
    }
  });

  it('keeps a replace of the same SKU when the line has a different SKU row', () => {
    const order = orderDetailOf();
    const body = buildEditBody(
      order,
      formWith({
        action: 'replace',
        sku: { id: VARIANT_M, code: 'TEE-RED-M', name: {} },
        quantity: '5',
      }),
      options,
    );
    expect(body.operations).toHaveLength(1);
  });

  it('trims the stored ship to values, so retyping an equal value sends nothing', () => {
    const base = orderDetailOf();
    const order = orderDetailOf({
      shipTo: { ...base.shipTo, address: '  12 Nile Street, Cairo  ', courierNote: ' Call first ' },
    });
    const form = { ...editDefaultsOf(order), address: '12 Nile Street, Cairo' };
    expect(buildEditBody(order, form, options).operations).toEqual([]);
  });

  it('sends null for an emptied second phone or courier note', () => {
    const base = orderDetailOf();
    const order = orderDetailOf({ shipTo: { ...base.shipTo, phoneAlt: '+201111111111' } });
    const form = { ...editDefaultsOf(order), phoneAlt: '', courierNote: '' };
    expect(buildEditBody(order, form, options).operations).toEqual([
      { kind: 'ship_to', phoneAlt: null, courierNote: null },
    ]);
  });
});
