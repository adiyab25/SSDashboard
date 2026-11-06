import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REDACTED, redact } from '../dist/redaction.js';

/** The real row shapes of packages/db/src/schema/{customers,connectors,orders}.ts (camelCase, as Drizzle returns them). */
const customerRow = {
  id: 'c-1',
  tenantId: 't-1',
  name: 'Mona Hassan',
  mergedIntoId: null,
  riskFlag: 'returner',
  riskFlagSource: 'manual',
  riskFlagNote: 'rude on the phone, lives at 12 Tahrir St',
  createdAt: '2026-11-06T00:00:00Z',
  updatedAt: '2026-11-06T00:00:00Z',
};

const customerPhoneRow = {
  id: 'p-1',
  customerId: 'c-1',
  phoneE164: '+201001234567',
  kind: 'mobile',
  isPrimary: true,
};

const mergeRow = {
  id: 'm-1',
  action: 'merge',
  survivorId: 'c-1',
  mergedId: 'c-2',
  repointedIds: [],
  undoesMergeId: null,
  reason: 'same woman, new phone 01001234567',
  actorId: 'u-1',
};

const commandRow = {
  id: 'k-1',
  connectionId: 'x-1',
  kind: 'shopify.order_edit',
  linkedType: 'order',
  linkedId: 'o-1',
  payload: { address1: '12 Tahrir St', phone: '01001234567' },
  idempotencyKey: 'order_edit:o-1:7',
  syncState: 'failed',
  failureReason: 'Shopify said: address 12 Tahrir St is invalid',
  attempts: 2,
};

const orderRow = {
  id: 'o-1',
  storeId: 's-1',
  orderNumber: '#1001',
  totalAmount: '2450.00',
  customerId: 'c-1',
  shipToName: 'Mona Hassan',
  shipToPhone: '+201001234567',
  shipToPhoneAlt: '+201112345678',
  contactPhoneRaw: '0100 123 4567',
  shipToAddress: '12 Tahrir St, Dokki',
  shipToAreaList: 'bosta',
  shipToGovernorateCode: 'EG-C',
  shipToCityCode: 'CAI',
  shipToZoneCode: 'DOK',
  courierNote: 'call before coming',
};

/** The same row bare, nested under an object key, and inside an array. */
function placements(row) {
  return [
    ['bare', row, (out) => out],
    ['nested under a key', { order: row }, (out) => out.order],
    ['inside an array', { rows: [row] }, (out) => out.rows[0]],
  ];
}

/** Checks `redacted` fields are hidden and `kept` fields are untouched, in all three placements. */
function checkRow(row, redacted, kept) {
  for (const [where, input, pick] of placements(row)) {
    const out = pick(redact(input));
    for (const key of redacted) {
      assert.equal(out[key], REDACTED, `${key} ${where}`);
    }
    for (const key of kept) {
      assert.deepEqual(out[key], row[key], `${key} ${where}`);
    }
  }
}

/** Snake case copy of a camelCase row, as raw SQL or a JSON export would carry it. */
function snake(row) {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]),
  );
}

describe('redaction of the order, customer, and task rows', () => {
  it('redacts a customers row name and risk note, keeping ids and flags', () => {
    checkRow(
      customerRow,
      ['name', 'riskFlagNote'],
      ['id', 'mergedIntoId', 'riskFlag', 'riskFlagSource'],
    );
  });

  it('redacts a customers row in snake case', () => {
    const out = redact(snake(customerRow));
    assert.equal(out.name, REDACTED);
    assert.equal(out.risk_flag_note, REDACTED);
    assert.equal(out.id, 'c-1');
  });

  it('marks a customer by any one of its own keys', () => {
    for (const key of ['mergedIntoId', 'riskFlagSource', 'riskFlagNote', 'riskFlag']) {
      assert.equal(redact({ name: 'Mona Hassan', [key]: 'x' }).name, REDACTED, key);
    }
  });

  it('redacts a customer_phones row phone and nothing operational', () => {
    checkRow(customerPhoneRow, ['phoneE164'], ['id', 'customerId', 'kind', 'isPrimary']);
  });

  it('redacts a customer_merges row reason', () => {
    checkRow(mergeRow, ['reason'], ['id', 'action', 'survivorId', 'mergedId', 'actorId']);
  });

  it('marks a merge by any one of its own keys', () => {
    for (const key of ['survivorId', 'mergedId', 'undoesMergeId', 'repointedIds']) {
      assert.equal(redact({ reason: 'same woman', [key]: 'x' }).reason, REDACTED, key);
    }
  });

  it('redacts an outbound_commands row payload and failure reason', () => {
    checkRow(
      commandRow,
      ['payload', 'failureReason'],
      ['id', 'kind', 'linkedType', 'linkedId', 'idempotencyKey', 'syncState', 'attempts'],
    );
  });

  it('marks a command by syncState alone, or by idempotencyKey with linkedType', () => {
    assert.equal(redact({ syncState: 'waiting', payload: { a: 1 } }).payload, REDACTED);
    assert.equal(
      redact({ idempotencyKey: 'k', linkedType: 'order', payload: { a: 1 } }).payload,
      REDACTED,
    );
    assert.deepEqual(redact({ idempotencyKey: 'k', payload: { a: 1 } }).payload, { a: 1 });
  });

  it('redacts every personal order field and keeps the operational ones', () => {
    checkRow(
      orderRow,
      [
        'shipToName',
        'shipToPhone',
        'shipToPhoneAlt',
        'contactPhoneRaw',
        'shipToAddress',
        'shipToGovernorateCode',
        'shipToCityCode',
        'shipToZoneCode',
        'courierNote',
      ],
      ['id', 'orderNumber', 'totalAmount', 'customerId', 'shipToAreaList'],
    );
  });

  it('redacts an order row in snake case', () => {
    const out = redact(snake(orderRow));
    for (const key of [
      'ship_to_name',
      'ship_to_phone',
      'ship_to_phone_alt',
      'contact_phone_raw',
      'ship_to_address',
      'ship_to_governorate_code',
      'ship_to_city_code',
      'ship_to_zone_code',
      'courier_note',
    ]) {
      assert.equal(out[key], REDACTED, key);
    }
    assert.equal(out.order_number, '#1001');
  });

  it('redacts a task note', () => {
    assert.equal(redact({ id: 't-1', status: 'open', note: 'call 12 Tahrir St' }).note, REDACTED);
  });

  it('keeps an operational reason and a product name readable', () => {
    assert.deepEqual(redact({ reason: 'locked_out', userId: 'u-1' }), {
      reason: 'locked_out',
      userId: 'u-1',
    });
    assert.deepEqual(redact({ name: 'Linen shirt', sku: 'LS-1' }), {
      name: 'Linen shirt',
      sku: 'LS-1',
    });
    assert.deepEqual(redact({ payload: { count: 3 } }), { payload: { count: 3 } });
    assert.deepEqual(redact({ items: [{ name: 'Linen shirt', reason: 'void' }] }), {
      items: [{ name: 'Linen shirt', reason: 'void' }],
    });
  });
});

/** The real row shapes of packages/db/src/schema/settlement.ts (camelCase, as Drizzle returns them). */
const periodEventRow = {
  id: 'e-1',
  tenantId: 't-1',
  periodId: 'sp-1',
  action: 'revoked',
  evidence: null,
  reason: 'partner called: Mona at 01001234567 says the sales were wrong',
  actorType: 'person',
  actorId: 'u-1',
  recordedAt: '2026-11-06T00:00:00Z',
};

const settlementLineRow = {
  id: 'l-1',
  tenantId: 't-1',
  accountId: 'a-1',
  statementId: 'st-1',
  lineKind: 'adjustment',
  amount: '-120.00',
  externalLineRef: '14',
  occurredOn: '2026-11-04',
  trackingNumber: 'TRK-1',
  partnerCode: 'SH-1',
  partnerText: 'returned by Mona Hassan, 12 Tahrir St',
  partnerOrderRef: 'PO-77',
  quantity: -1,
};

const settlementMatchRow = {
  id: 'mt-1',
  tenantId: 't-1',
  lineId: 'l-1',
  result: 'accounted',
  orderId: null,
  accountCode: 'payment_received',
  paymentReference: 'InstaPay from mona.h@bank 01001234567',
  reasonCode: null,
  matchedByType: 'person',
  supersedesMatchId: null,
};

describe('redaction of the settlement rows', () => {
  it('redacts a period event reason, keeping the action and ids', () => {
    checkRow(periodEventRow, ['reason'], ['id', 'periodId', 'action', 'actorType', 'actorId']);
  });

  it('redacts a period event reason in snake case', () => {
    const out = redact(snake(periodEventRow));
    assert.equal(out.reason, REDACTED);
    assert.equal(out.period_id, 'sp-1');
  });

  it('marks a period event by periodId with action, not by either alone', () => {
    assert.equal(redact({ periodId: 'p', action: 'closed', reason: 'x' }).reason, REDACTED);
    assert.equal(redact({ action: 'closed', reason: 'locked_out' }).reason, 'locked_out');
    assert.equal(redact({ periodId: 'p', reason: 'locked_out' }).reason, 'locked_out');
  });

  it('redacts the partner wording on a statement line, keeping the facts', () => {
    checkRow(
      settlementLineRow,
      ['partnerText'],
      [
        'id',
        'lineKind',
        'amount',
        'externalLineRef',
        'trackingNumber',
        'partnerCode',
        'partnerOrderRef',
      ],
    );
  });

  it('redacts a match row payment reference, keeping the result and codes', () => {
    checkRow(
      settlementMatchRow,
      ['paymentReference'],
      ['id', 'lineId', 'result', 'accountCode', 'reasonCode', 'supersedesMatchId'],
    );
  });

  it('redacts both in snake case', () => {
    assert.equal(redact(snake(settlementLineRow)).partner_text, REDACTED);
    assert.equal(redact(snake(settlementMatchRow)).payment_reference, REDACTED);
  });
});
