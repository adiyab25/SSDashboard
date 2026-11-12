import type { NormalizedPhone } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import type { Transaction } from '../../database/sql.js';
import { findOrCreate, type ChannelCustomerRef } from './find-or-create.js';

const PHONE: NormalizedPhone = { e164: '+201001234567', kind: 'mobile' };
const CHANNEL: ChannelCustomerRef = {
  kind: 'shopify_customer',
  connectionId: '11111111-1111-4111-8111-111111111111',
  externalId: 'gid://shopify/Customer/1',
};
const SEEN = new Date('2026-11-09T10:00:00Z');

/** The SQL text of a Drizzle `sql` object, nested objects included (the bound values are left out). */
function textOf(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk !== 'object' || chunk === null) return '?';
      const part = chunk as { value?: unknown; queryChunks?: unknown[] };
      if (Array.isArray(part.value)) return part.value.join('');
      if (part.queryChunks) return textOf(part);
      return '?';
    })
    .join('');
}

/** A fake transaction: the two lookups answer what the test says; every statement is recorded. */
function fakeTx(known: { phone: string | null; channel: string | null }) {
  const statements: string[] = [];
  const tx = {
    execute: (query: unknown) => {
      const text = textOf(query).replace(/\s+/g, ' ').trim();
      statements.push(text);
      if (text.includes('FROM customer_phones p')) {
        return Promise.resolve({
          rows: known.phone ? [{ row_id: 'phone-row', customer_id: known.phone }] : [],
        });
      }
      if (text.includes('FROM customer_external_ids e')) {
        return Promise.resolve({
          rows: known.channel ? [{ row_id: 'channel-row', customer_id: known.channel }] : [],
        });
      }
      return Promise.resolve({ rows: [{ id: 'new-row' }] });
    },
  } as unknown as Transaction;
  const writes = () => statements.filter((s) => /^(INSERT|UPDATE)/.test(s));
  return { tx, writes };
}

describe('findOrCreate with an unverified phone (owner ruling L1)', () => {
  it('rule b: a known phone with an unknown channel id links nothing and writes nothing', async () => {
    const { tx, writes } = fakeTx({ phone: 'customer-a', channel: null });

    const result = await findOrCreate(tx, {
      phone: PHONE,
      channelCustomer: CHANNEL,
      name: 'Mona',
      seenAt: SEEN,
      phoneVerified: false,
    });

    expect(result).toEqual({ customerId: null, outcome: 'unverified_phone' });
    expect(writes()).toEqual([]);
  });

  it('rule b by default still attaches the channel id to the phone customer', async () => {
    const { tx, writes } = fakeTx({ phone: 'customer-a', channel: null });

    const result = await findOrCreate(tx, {
      phone: PHONE,
      channelCustomer: CHANNEL,
      name: null,
      seenAt: SEEN,
    });

    expect(result).toEqual({ customerId: 'customer-a', outcome: 'matched' });
    expect(writes().some((s) => s.startsWith('INSERT INTO customer_external_ids'))).toBe(true);
  });

  it('rule c: a known channel id with a new phone attaches no phone and answers the channel customer', async () => {
    const { tx, writes } = fakeTx({ phone: null, channel: 'customer-b' });

    const result = await findOrCreate(tx, {
      phone: PHONE,
      channelCustomer: CHANNEL,
      name: null,
      seenAt: SEEN,
      phoneVerified: false,
    });

    expect(result).toEqual({ customerId: 'customer-b', outcome: 'unverified_phone' });
    expect(writes().some((s) => s.includes('customer_phones'))).toBe(false);
  });

  it('rule c by default still attaches the new phone', async () => {
    const { tx, writes } = fakeTx({ phone: null, channel: 'customer-b' });

    const result = await findOrCreate(tx, {
      phone: PHONE,
      channelCustomer: CHANNEL,
      name: null,
      seenAt: SEEN,
    });

    expect(result).toEqual({ customerId: 'customer-b', outcome: 'matched_by_channel_id' });
    expect(writes().some((s) => s.startsWith('INSERT INTO customer_phones'))).toBe(true);
  });

  it('rule a is unchanged: a known phone without a channel id matches', async () => {
    const { tx } = fakeTx({ phone: 'customer-a', channel: null });

    const result = await findOrCreate(tx, {
      phone: PHONE,
      channelCustomer: null,
      name: null,
      seenAt: SEEN,
      phoneVerified: false,
    });

    expect(result).toEqual({ customerId: 'customer-a', outcome: 'matched' });
  });
});
