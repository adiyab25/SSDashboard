import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  EMAIL_MASK,
  PHONE_MASK,
  REDACTED,
  maskEmails,
  maskPhones,
  redact,
} from '../dist/redaction.js';

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

// Security review AS15 (spec 0010, milestone 2): notations the phone rule missed, and emails in
// free text. Every log sink shares this function, so the codes and instants a log line carries
// must stay readable.
describe('maskPhones notations', () => {
  const masked = [
    ['a left to right mark and a right to left mark inside', 'call 010‎1234‏5678 now'],
    ['a zero width space inside', '0101​2345678'],
    ['brackets around the prefix', '(010) 1234 5678'],
    ['slashes', '010/1234/5678'],
    ['underscores', '010_1234_5678'],
    ['full width digits', '０１０１２３４５６７８'],
    ['a Cairo landline in groups', '02 2345 6789'],
    ['a Cairo landline in one run', '0223456789'],
    ['an Alexandria landline', '03 123 4567'],
    ['a two digit area code landline', '040 123 4567'],
    ['a bracketed area code', '(02) 2345-6789'],
  ];
  for (const [what, text] of masked) {
    it(`masks a phone with ${what}`, () => {
      const out = maskPhones(text);
      assert.ok(out.includes(PHONE_MASK), out);
      assert.ok(!/[0-9０-９]{4}/.test(out), out);
    });
  }

  it('masks the whole original span, marks included', () => {
    assert.equal(maskPhones('call 010‎1234‏5678 now'), `call ${PHONE_MASK} now`);
  });

  const kept = [
    'SR-2026-000001',
    'TEE-BLK-M',
    '2026-11-06T10:00:00.123456Z',
    '10:00:00.023456Z',
    'order #1001 total 2450.00',
    '06/11/2026 12:30',
    '06.11.2026 12:30',
    'WH_CAI.2',
  ];
  for (const text of kept) {
    it(`keeps ${text}`, () => assert.equal(maskPhones(text), text));
  }
});

describe('maskEmails', () => {
  it('masks an email in free text, Latin or Arabic domain', () => {
    assert.equal(
      maskEmails('write to sentinel.name+x@example.co.eg today'),
      `write to ${EMAIL_MASK} today`,
    );
    assert.equal(maskEmails('a@مثال.com'), EMAIL_MASK);
  });

  it('keeps text with no address', () => {
    assert.equal(
      maskEmails('voided: entered twice @ the counter'),
      'voided: entered twice @ the counter',
    );
  });

  // Gate ruling 2026-11-07 (Law 151): redact masks every address in every string; staff are
  // named by id in log lines.
  it('is applied by redact to free text and to a database error message', () => {
    assert.equal(redact('signed in ahmed@example.com'), `signed in ${EMAIL_MASK}`);
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_unique"'),
      { detail: 'Key (lower(email))=(ahmed@example.com) already exists.', code: '23505' },
    );
    const out = redact(pgError);
    assert.ok(out instanceof Error);
    assert.equal(out.detail, `Key (lower(email))=(${EMAIL_MASK}) already exists.`);
    assert.equal(out.code, '23505');
    assert.equal(
      redact({ message: 'mail to ahmed@example.com failed' }).message,
      `mail to ${EMAIL_MASK} failed`,
    );
  });

  // Security review AS24: one pass over the text, so a long line cannot stall a log call.
  it('runs in linear time: 100,000 characters in under 50 ms', () => {
    for (const text of ['a'.repeat(100_000), 'a@'.repeat(50_000), `${'a.'.repeat(50_000)}@x`]) {
      const started = performance.now();
      maskEmails(text);
      assert.ok(performance.now() - started < 50, `${text.slice(0, 4)}...`);
    }
  });
});

// Security review AS22: the wider separators and the landline rule must not read ids as phones.
describe('maskPhones and ids', () => {
  it('masks no digits of 10,000 random uuids, bare or inside text', () => {
    for (let i = 0; i < 10_000; i += 1) {
      const id = randomUUID();
      assert.equal(maskPhones(id), id);
      assert.equal(redact(`order ${id} failed`), `order ${id} failed`);
    }
  });

  // Security review AS27: a phone may sit right next to letters; only a longer digit run is not one.
  it('masks a phone glued to letters, but not a longer digit run', () => {
    assert.equal(maskPhones('call01012345678'), `call${PHONE_MASK}`);
    assert.equal(maskPhones('01012345678ext'), `${PHONE_MASK}ext`);
    assert.equal(maskPhones('x01012345678y'), `x${PHONE_MASK}y`);
    assert.equal(maskPhones('SKU-01012345678'), `SKU-${PHONE_MASK}`);
    assert.equal(maskPhones('9010123456789'), '9010123456789');
  });

  // Security review AS25: only a match wholly inside a standalone uuid is skipped.
  it('masks a phone that only touches or overlaps a uuid like text', () => {
    assert.equal(
      maskPhones('call 01012345678-0000-0000-0000-000000000000'),
      `call ${PHONE_MASK}-0000-0000-0000-000000000000`,
    );
    assert.equal(
      maskPhones('call 01012345678-aaaa-bbbb-cccc-dddddddddddd'),
      `call ${PHONE_MASK}-aaaa-bbbb-cccc-dddddddddddd`,
    );
    assert.equal(
      maskPhones('+20 10 12345678-0000-0000-0000-000000000000'),
      `${PHONE_MASK}-0000-0000-0000-000000000000`,
    );
  });

  it('keeps a phone written as a uuid last group: it cannot be told apart from a uuid', () => {
    const text = 'ref aaaaaaaa-bbbb-cccc-dddd-201012345678';
    assert.equal(maskPhones(text), text);
  });

  // Security review AS26: phones and uuids are walked together once.
  it('masks 5,000 phones among 5,000 uuids in under 50 ms', () => {
    const parts = [];
    for (let i = 0; i < 5_000; i += 1) parts.push(`01012345678 ${randomUUID()}`);
    const text = parts.join(' ');
    maskPhones(text);
    const started = performance.now();
    const out = maskPhones(text);
    assert.ok(performance.now() - started < 50);
    assert.equal(out.split(PHONE_MASK).length - 1, 5_000);
  });
});
