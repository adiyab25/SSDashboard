import {
  OwnerPoliciesResponse,
  PutOwnerPolicyAnswer,
  type OwnerPolicyFields,
  type OwnerPolicyView,
} from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocationPolicyService } from '../src/inventory/locations/location-policy.service.js';
import { LocationsService } from '../src/inventory/locations/locations.service.js';
import { startInProcessApi, type InProcessApi } from './in-process-api.js';

// Spec 0009 milestone 5, task 25 (AC-24): a holder of `settings.manage` edits a location owner
// type policy through `PUT /api/inventory/owner-policies/:ownerType`, with a reason, the
// `policy.changed` audit entry, and the stale check. It refuses an inconsistent row (422
// OWNER_POLICY_INCONSISTENT), a locked field of the brand's own row or of a type with a location
// that is not archived (409 OWNER_POLICY_IN_USE), and turning online selling off while a location
// of the type sells online (409 SELLABLE_LOCATIONS_EXIST). A change answers only future
// questions: the next `policyFor` reads the new row.
describe('owner type policies (spec 0009, AC-24)', { timeout: 120_000 }, () => {
  let api: InProcessApi;
  let manager: string;
  let managerId: string;
  let support: string;
  let counter = 0;

  const list = async (): Promise<OwnerPolicyView[]> => {
    const reply = await api.call(manager, 'GET', '/api/inventory/owner-policies');
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return OwnerPoliciesResponse.parse(reply.body).policies;
  };
  const policy = async (ownerType: string): Promise<OwnerPolicyView> => {
    const found = (await list()).find((row) => row.ownerType === ownerType);
    if (!found) throw new Error(`no policy ${ownerType}`);
    return found;
  };
  const fieldsOf = (view: OwnerPolicyView): OwnerPolicyFields => ({
    stockOwnedByBrand: view.stockOwnedByBrand,
    handoverIsSale: view.handoverIsSale,
    saleRecordedAt: view.saleRecordedAt,
    endCustomerRefundBy: view.endCustomerRefundBy,
    defectivePieceRefundBy: view.defectivePieceRefundBy,
    taxDocument: view.taxDocument,
    settlementOwnerType: view.settlementOwnerType,
    canSellOnline: view.canSellOnline,
  });
  /** Puts the row of `ownerType` with `change` over its current fields. */
  const put = async (
    ownerType: string,
    change: Partial<OwnerPolicyFields>,
    options: { reason?: string; expectedUpdatedAt?: string; cookie?: string } = {},
  ) => {
    const current = await policy(ownerType);
    return api.call(
      options.cookie ?? manager,
      'PUT',
      `/api/inventory/owner-policies/${ownerType}`,
      {
        ...fieldsOf(current),
        ...change,
        ...('reason' in options ? { reason: options.reason } : { reason: 'Agreed with the brand' }),
        expectedUpdatedAt: options.expectedUpdatedAt ?? current.updatedAt,
      },
    );
  };
  const policyEntries = async (label: string) =>
    (
      await api.owner.pool.query<{
        record_type: string;
        reason: string;
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }>(
        `SELECT record_type, reason, before, after FROM audit_entries
         WHERE action = 'policy.changed' AND record_label = $1 ORDER BY recorded_at`,
        [label],
      )
    ).rows;
  const newLocation = async (ownerType: string, options: { sellableOnline?: boolean } = {}) => {
    counter += 1;
    const role = ownerType === 'own' ? undefined : ownerType;
    const partyId =
      role === undefined
        ? undefined
        : // A party needs a role to exist; a wholesale customer is moved over just after.
          await api.addParty(`OP-${counter}`, { consignment: true });
    if (role === 'wholesale_customer' && partyId) {
      await api.owner.pool.query(
        'UPDATE parties SET is_consignment_partner = false, is_wholesale_customer = true WHERE id = $1',
        [partyId],
      );
    }
    return api.app.get(LocationsService).create({
      code: `OP-${counter}`,
      name: { en: 'Shop' },
      kind: 'shop',
      ownerType: ownerType as 'own',
      ...(partyId !== undefined && { partyId }),
      ...(options.sellableOnline !== undefined && { sellableOnline: options.sellableOnline }),
    });
  };

  beforeAll(async () => {
    api = await startInProcessApi();
    const managerPerson = await api.addPerson(['manager']);
    managerId = managerPerson.id;
    manager = await api.signIn(managerPerson.email);
    support = await api.signIn((await api.addPerson(['support'])).email);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('lists the three rows, the brand own row locked always and the others while used', async () => {
    const rows = await list();
    expect(rows.map((row) => row.ownerType)).toEqual([
      'own',
      'consignment_partner',
      'wholesale_customer',
    ]);
    const own = rows[0] as OwnerPolicyView;
    expect(own.lockedFields.sort()).toEqual([
      'handoverIsSale',
      'saleRecordedAt',
      'settlementOwnerType',
      'stockOwnedByBrand',
      'taxDocument',
    ]);
    // The seeded system locations (in transit, scrap) are the brand's own.
    expect(own.activeLocations).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ lockedFields: [], activeLocations: 0, updatedBy: null });
  });

  it('refuses an inconsistent row (422 OWNER_POLICY_INCONSISTENT)', async () => {
    const handover = await put('consignment_partner', { handoverIsSale: true });
    expect(handover.status, JSON.stringify(handover.body)).toBe(422);
    expect(handover.body).toMatchObject({
      code: 'OWNER_POLICY_INCONSISTENT',
      rules: ['handover_is_sale_means_customer_stock', 'sale_at_handover_means_handover_is_sale'],
    });
    // Owner ruling 2026-11-08 ("pin it"): the consignment row always settles with its partner.
    // No consignment location exists yet, so this is the rule refusing, not the lock.
    expect((await policy('consignment_partner')).activeLocations).toBe(0);
    const unsettled = await put('consignment_partner', { settlementOwnerType: null });
    expect(unsettled.status, JSON.stringify(unsettled.body)).toBe(422);
    expect(unsettled.body).toMatchObject({
      code: 'OWNER_POLICY_INCONSISTENT',
      rules: ['consignment_settles_with_partner'],
    });
    // Partner stock is the brand's, but its sales settle through the partner: never online.
    const partnerOnline = await put('consignment_partner', { canSellOnline: true });
    expect(partnerOnline.status, JSON.stringify(partnerOnline.body)).toBe(422);
    expect(partnerOnline.body).toMatchObject({
      code: 'OWNER_POLICY_INCONSISTENT',
      rules: ['online_needs_brand_stock'],
    });
    const online = await put('wholesale_customer', { canSellOnline: true });
    expect(online.status, JSON.stringify(online.body)).toBe(422);
    expect(online.body).toMatchObject({ rules: ['online_needs_brand_stock'] });
    expect(await policyEntries('wholesale_customer')).toEqual([]);
  });

  it('refuses a missing reason, an unknown owner type, and a person without settings.manage', async () => {
    const noReason = await put(
      'consignment_partner',
      { endCustomerRefundBy: 'brand' },
      { reason: ' ' },
    );
    expect(noReason.status).toBe(422);
    expect(noReason.body).toMatchObject({ code: 'REASON_REQUIRED' });
    // A body the pipe accepts, so the answer is the owner type check, not the body check.
    const sound = await policy('consignment_partner');
    const unknown = await api.call(manager, 'PUT', '/api/inventory/owner-policies/nobody', {
      ...fieldsOf(sound),
      reason: 'No such type',
      expectedUpdatedAt: sound.updatedAt,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'OWNER_TYPE_UNKNOWN' });
    const forbidden = await put(
      'consignment_partner',
      { endCustomerRefundBy: 'brand' },
      { cookie: support },
    );
    expect(forbidden.status).toBe(403);
    expect((await api.call(support, 'GET', '/api/inventory/owner-policies')).status).toBe(403);
  });

  // Spec 0009 *API surface* lists 422 REASON_REQUIRED for this route, as the settings and cost
  // rule routes answer for a missing reason (verify run 2026-11-08, bug 1: a body with no
  // `reason` key at all answered 422 VALIDATION_FAILED).
  it('answers REASON_REQUIRED when the body has no reason key at all, and changes nothing (AC-24)', async () => {
    const before = await policy('consignment_partner');

    const missing = await put(
      'consignment_partner',
      { endCustomerRefundBy: 'brand' },
      { reason: undefined },
    );

    expect(missing.status, JSON.stringify(missing.body)).toBe(422);
    expect(missing.body).toMatchObject({ code: 'REASON_REQUIRED' });
    expect((await policy('consignment_partner')).updatedAt).toBe(before.updatedAt);
  });

  it('refuses a stale edit (409 STALE_SETTING)', async () => {
    const stale = await put(
      'consignment_partner',
      { endCustomerRefundBy: 'brand' },
      { expectedUpdatedAt: '2020-01-01T00:00:00.000000Z' },
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'STALE_SETTING' });
  });

  it('changes a locked field of an unused type, then locks it once a location of the type exists (D13)', async () => {
    const free = await put('wholesale_customer', {
      taxDocument: 'b2b_electronic_invoice_at_settlement',
    });
    expect(free.status, JSON.stringify(free.body)).toBe(200);
    expect(PutOwnerPolicyAnswer.parse(free.body)).toMatchObject({
      changed: true,
      policy: {
        taxDocument: 'b2b_electronic_invoice_at_settlement',
        updatedBy: { name: expect.any(String) as string },
      },
    });

    await newLocation('consignment_partner');
    const partner = await policy('consignment_partner');
    expect(partner.activeLocations).toBe(1);
    expect(partner.lockedFields).toHaveLength(5);
    const locked = await put('consignment_partner', { taxDocument: 'b2c_electronic_receipt' });
    expect(locked.status, JSON.stringify(locked.body)).toBe(409);
    expect(locked.body).toMatchObject({ code: 'OWNER_POLICY_IN_USE', fields: ['taxDocument'] });
    // A consistent change of a locked field of the brand's own row: locked always.
    const own = await put('own', { taxDocument: 'b2b_electronic_invoice_at_handover' });
    expect(own.status, JSON.stringify(own.body)).toBe(409);
    expect(own.body).toMatchObject({ code: 'OWNER_POLICY_IN_USE', fields: ['taxDocument'] });
    // An inconsistent one answers the rule first (online selling with a settling partner).
    const ownCarrier = await put('own', { settlementOwnerType: 'carrier' });
    expect(ownCarrier.status).toBe(422);
    expect(ownCarrier.body).toMatchObject({
      code: 'OWNER_POLICY_INCONSISTENT',
      rules: ['online_needs_brand_stock'],
    });
  });

  it('edits a refund field of a used type, audits it, and the next policyFor answers it', async () => {
    const shop = await newLocation('consignment_partner');
    const service = api.app.get(LocationPolicyService);
    expect((await service.policyFor(shop.id)).endCustomerRefundBy).toBe('location_owner');

    const reply = await put('consignment_partner', { endCustomerRefundBy: 'brand' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body).toMatchObject({ changed: true, policy: { endCustomerRefundBy: 'brand' } });
    expect((await service.policyFor(shop.id)).endCustomerRefundBy).toBe('brand');
    expect(await policyEntries('consignment_partner')).toEqual([
      {
        record_type: 'policy',
        reason: 'Agreed with the brand',
        before: { endCustomerRefundBy: 'location_owner' },
        after: { endCustomerRefundBy: 'brand' },
      },
    ]);
    // The same row again changes nothing and writes no entry.
    const again = await put('consignment_partner', {});
    expect(again.body).toMatchObject({ changed: false });
    expect(await policyEntries('consignment_partner')).toHaveLength(1);
  });

  it('refuses turning online selling off while a location of the type sells online', async () => {
    await newLocation('own', { sellableOnline: true });
    const refused = await put('own', { canSellOnline: false });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({ code: 'SELLABLE_LOCATIONS_EXIST' });
    expect((await policy('own')).canSellOnline).toBe(true);
  });

  it('brings an archived location back while its type terms are unchanged', async () => {
    const service = api.app.get(LocationsService);
    const caller = { id: managerId, access: { actingHat: () => 'manager' } };
    const shop = await newLocation('own');
    await service.archive(shop.id, caller);
    const back = await api.call(manager, 'POST', `/api/locations/${shop.id}/unarchive`);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
  });

  it('brings back an archived location after a change of a free field only (D13)', async () => {
    const service = api.app.get(LocationsService);
    const caller = { id: managerId, access: { actingHat: () => 'manager' } };
    const shop = await newLocation('consignment_partner');
    await service.archive(shop.id, caller);
    const current = (await policy('consignment_partner')).defectivePieceRefundBy;
    const changed = await put('consignment_partner', {
      defectivePieceRefundBy: current === 'brand' ? 'location_owner' : 'brand',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ changed: true });

    const back = await api.call(manager, 'POST', `/api/locations/${shop.id}/unarchive`);
    expect(back.status, JSON.stringify(back.body)).toBe(200);
  });

  it('refuses to bring back a location archived before a locked term of its type changed (D13)', async () => {
    const service = api.app.get(LocationsService);
    const caller = { id: managerId, access: { actingHat: () => 'manager' } };
    // The type's only location is archived first, so its locked terms may change.
    const shop = await newLocation('wholesale_customer');
    await service.archive(shop.id, caller);
    expect((await policy('wholesale_customer')).activeLocations).toBe(0);
    const current = (await policy('wholesale_customer')).taxDocument;
    const changed = await put('wholesale_customer', {
      taxDocument:
        current === 'b2b_electronic_invoice_at_handover'
          ? 'b2b_electronic_invoice_at_settlement'
          : 'b2b_electronic_invoice_at_handover',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    const back = await api.call(manager, 'POST', `/api/locations/${shop.id}/unarchive`);
    expect(back.status, JSON.stringify(back.body)).toBe(409);
    expect(back.body).toMatchObject({ code: 'OWNER_POLICY_CHANGED_SINCE_ARCHIVE' });
    expect(JSON.stringify(back.body)).toContain('open a new location');
  });
});
