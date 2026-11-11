import { randomUUID } from 'node:crypto';
import {
  AUDIT_ACTIONS,
  CustomerMergeResponse,
  personActor,
  type NormalizedPhone,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomersService } from '../src/customers/customers.service.js';
import { DATABASE } from '../src/database/database.module.js';
import type { DatabaseConnection } from '@ssdashboard/db';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0014 Audit actions and spec 0010 AC-19: the proof that every customers code writes its
// entry: `customer.merged` (one per changed record, the undo only on the merged record's),
// `customer.unmerged`, `customer.merged_undone` (the audit screen's undo through
// `customers.merge_undo`), `customer.merge_suggestion_dismissed`, and `customer.phone_added`.
// Entries of record type `customer` carry ids and codes only, never a name or a phone (AC-17).
// `customer.flagged` and `customer.unflagged` arrive with milestone 3.
describe('customers audit', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let customers: CustomersService;
  let db: DatabaseConnection;
  let support = '';
  let supportId = '';
  let manager = '';
  let counter = 0;
  const NAME = 'Zzauditsentinel Name';

  beforeAll(async () => {
    api = await startInProcessApi();
    const person = await api.addPerson(['support']);
    supportId = person.id;
    support = await api.signIn(person.email);
    manager = await api.signIn((await api.addPerson(['manager'])).email);
    customers = api.app.get(CustomersService);
    db = api.app.get<DatabaseConnection>(DATABASE);
  });

  afterAll(async () => {
    await api?.close();
  });

  const newPhone = (): NormalizedPhone => {
    counter += 1;
    return { e164: `+2012${String(counter).padStart(8, '0')}`, kind: 'mobile' };
  };
  const customer = async (): Promise<{ id: string; phone: NormalizedPhone }> => {
    const phone = newPhone();
    const { customerId } = await db.db.transaction((tx) =>
      customers.findOrCreate(tx, { phone, channelCustomer: null, name: NAME, seenAt: new Date() }),
    );
    return { id: customerId as string, phone };
  };
  const entriesOf = async (action: string, recordId: string) =>
    (
      await api.owner.pool.query<{
        record_type: string;
        record_label: string | null;
        reason: string | null;
        actor_kind: string;
        undo_action: string | null;
        undo_args: unknown;
        before: unknown;
        after: unknown;
        correlation_id: string;
      }>(
        `SELECT record_type, record_label, reason, actor_kind, undo_action, undo_args, before, after,
                correlation_id
         FROM audit_entries WHERE action = $1 AND record_id = $2 ORDER BY recorded_at`,
        [action, recordId],
      )
    ).rows;

  it('registers the four milestone 2 codes on the customer record type with code reasons', () => {
    const codes = Object.keys(AUDIT_ACTIONS).filter((code) => code.startsWith('customer.'));

    expect(codes).toEqual([
      'customer.merged',
      'customer.unmerged',
      'customer.merge_suggestion_dismissed',
      'customer.phone_added',
    ]);
    expect(AUDIT_ACTIONS['customer.merged']).toMatchObject({
      undoable: true,
      undoHandler: 'customers.merge_undo',
      undoRefusalCodes: ['MERGE_NOT_LATEST', 'MERGE_ALREADY_UNDONE'],
    });
  });

  it('writes customer.merged on each changed record under one correlation id, the undo on the merged record only', async () => {
    const a = await customer();
    const b = await customer();
    const c = await customer();
    const first = await api.call(support, 'POST', '/api/customers/merges', {
      survivorId: c.id,
      mergedId: b.id,
    });
    expect(first.status).toBe(201);

    const reply = await api.call(support, 'POST', '/api/customers/merges', {
      survivorId: a.id,
      mergedId: c.id,
      reasonCode: 'same_person',
    });
    const made = CustomerMergeResponse.parse(reply.body);

    const [onMerged] = await entriesOf('customer.merged', c.id);
    const onRepointed = (await entriesOf('customer.merged', b.id)).at(-1);
    expect(onMerged).toMatchObject({
      record_type: 'customer',
      record_label: null,
      reason: 'same_person',
      actor_kind: 'person',
      undo_action: 'customers.merge_undo',
      undo_args: { mergeId: made.mergeId },
      before: { mergedIntoId: null },
      after: { mergedIntoId: a.id, mergeId: made.mergeId, repointedCount: 1 },
    });
    expect(onRepointed).toMatchObject({
      undo_action: null,
      before: { mergedIntoId: c.id },
      after: { mergedIntoId: a.id, mergeId: made.mergeId },
    });
    expect(onRepointed?.correlation_id).toBe(onMerged?.correlation_id);
    expect(await entriesOf('customer.merged', a.id)).toEqual([]);
  });

  it('writes customer.unmerged with its required reason on each record the undo moved back', async () => {
    const a = await customer();
    const b = await customer();
    const made = CustomerMergeResponse.parse(
      (
        await api.call(support, 'POST', '/api/customers/merges', {
          survivorId: a.id,
          mergedId: b.id,
        })
      ).body,
    );

    const reply = await api.call(support, 'POST', `/api/customers/merges/${made.mergeId}/undo`, {
      reasonCode: 'wrong_merge',
    });

    expect(reply.status).toBe(200);
    expect(await entriesOf('customer.unmerged', b.id)).toMatchObject([
      {
        reason: 'wrong_merge',
        before: { mergedIntoId: a.id },
        after: { mergedIntoId: null, mergeId: made.mergeId },
      },
    ]);
  });

  it('writes customer.merged_undone on the merged record when the audit screen undoes the merge', async () => {
    const a = await customer();
    const b = await customer();
    await api.call(support, 'POST', '/api/customers/merges', { survivorId: a.id, mergedId: b.id });
    const [entry] = await api.owner.pool
      .query<{ id: string }>(
        `SELECT id FROM audit_entries WHERE action = 'customer.merged' AND record_id = $1`,
        [b.id],
      )
      .then((r) => r.rows);

    const reply = await api.call(manager, 'POST', `/api/audit/entries/${entry?.id}/undo`, {
      reason: 'different_people',
    });

    expect(reply.status).toBe(200);
    expect(await entriesOf('customer.merged_undone', b.id)).toMatchObject([
      { reason: 'different_people', before: { mergedIntoId: a.id }, after: { mergedIntoId: null } },
    ]);
  });

  it('writes customer.merge_suggestion_dismissed on both customers of the pair', async () => {
    const a = await customer();
    const b = await customer();
    await db.db.transaction((tx) =>
      customers.addPhone(tx, a.id, b.phone, personActor(supportId, 'support')),
    );
    const suggestion = (
      await api.owner.pool.query<{ id: string }>(
        `SELECT id FROM customer_merge_suggestions
         WHERE customer_low_id = LEAST($1::uuid, $2::uuid) AND customer_high_id = GREATEST($1::uuid, $2::uuid)`,
        [a.id, b.id],
      )
    ).rows[0]?.id;

    const reply = await api.call(
      support,
      'POST',
      `/api/customers/merge-suggestions/${suggestion}/dismiss`,
      { reasonCode: 'different_people' },
    );

    expect(reply.status).toBe(204);
    for (const [id, other] of [
      [a.id, b.id],
      [b.id, a.id],
    ] as const) {
      expect(await entriesOf('customer.merge_suggestion_dismissed', id)).toMatchObject([
        {
          reason: 'different_people',
          after: {
            suggestionId: suggestion,
            suggestionStatus: 'dismissed',
            otherCustomerId: other,
          },
        },
      ]);
    }
  });

  it('writes customer.phone_added for a person under the caller’s correlation id, and nothing for a system job', async () => {
    const a = await customer();
    const second = newPhone();
    const third = newPhone();
    const joined = randomUUID();

    await db.db.transaction((tx) =>
      customers.addPhone(tx, a.id, second, personActor(supportId, 'support'), {
        reasonCode: 'confirmed_by_customer',
        correlationId: joined,
      }),
    );
    await db.db.transaction((tx) =>
      customers.addPhone(tx, a.id, third, {
        kind: 'system_job',
        name: 'confirmation',
        jobId: '01937f3a-0000-7000-8000-00000000000a',
      }),
    );

    const entries = await entriesOf('customer.phone_added', a.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      reason: 'confirmed_by_customer',
      after: { isPrimary: false },
      correlation_id: joined,
    });
  });

  it('keeps every customer entry free of names and phones', async () => {
    const { rows } = await api.owner.pool.query<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM audit_entries a WHERE record_type = 'customer'`,
    );
    const all = rows.map((row) => row.text).join('\n');

    expect(rows.length).toBeGreaterThan(5);
    expect(all).not.toContain('Zzauditsentinel');
    expect(all).not.toMatch(/\+2012\d{8}/);
  });
});
