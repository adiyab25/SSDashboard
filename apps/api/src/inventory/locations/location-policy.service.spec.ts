import { LocationOwnerType, type OwnerPolicyFields } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import {
  LocationPolicyError,
  LocationPolicyService,
  brokenCheckOf,
  ownerPolicyInconsistencies,
  ownerPolicyRecordId,
  requiredPartyRole,
} from './location-policy.service.js';

describe('requiredPartyRole', () => {
  it('maps every owner type to the party role it needs, and the brand to none', () => {
    expect(LocationOwnerType.options.map((ownerType) => requiredPartyRole(ownerType))).toEqual([
      null,
      'is_consignment_partner',
      'is_wholesale_customer',
    ]);
  });
});

describe('LocationPolicyService.assertCanCreate', () => {
  // A connection is never reached: these cases fail before any query.
  const service = new LocationPolicyService({ db: {} } as never, {} as never);
  const code = async (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => (error instanceof LocationPolicyError ? error.code : String(error)),
    );

  it('refuses a party on the brand own location', async () => {
    expect(await code(service.assertCanCreate({ partyId: 'p' }))).toBe('PartyRoleMismatch');
  });

  it('refuses a partner location without a party', async () => {
    expect(await code(service.assertCanCreate({ ownerType: 'consignment_partner' }))).toBe(
      'PartyRoleMismatch',
    );
  });
});

// Spec 0009, AC-24: the consistency rules of a policy row; the seeded rows keep all three.
describe('ownerPolicyInconsistencies', () => {
  const brandStock: OwnerPolicyFields = {
    stockOwnedByBrand: true,
    handoverIsSale: false,
    saleRecordedAt: 'at_shipment',
    endCustomerRefundBy: 'brand',
    defectivePieceRefundBy: 'brand',
    taxDocument: 'b2c_electronic_receipt',
    settlementOwnerType: null,
    canSellOnline: true,
  };
  const customerStock: OwnerPolicyFields = {
    ...brandStock,
    stockOwnedByBrand: false,
    handoverIsSale: true,
    saleRecordedAt: 'at_handover',
    canSellOnline: false,
  };

  it('finds nothing wrong with a sound row of either kind', () => {
    expect(ownerPolicyInconsistencies(brandStock, 'own')).toEqual([]);
    expect(ownerPolicyInconsistencies(customerStock, 'wholesale_customer')).toEqual([]);
    expect(
      ownerPolicyInconsistencies(
        {
          ...brandStock,
          saleRecordedAt: 'at_sell_through',
          settlementOwnerType: 'consignment_partner',
          canSellOnline: false,
        },
        'consignment_partner',
      ),
    ).toEqual([]);
  });

  it('names each broken rule', () => {
    expect(ownerPolicyInconsistencies({ ...brandStock, handoverIsSale: true }, 'own')).toEqual([
      'handover_is_sale_means_customer_stock',
      'sale_at_handover_means_handover_is_sale',
    ]);
    expect(
      ownerPolicyInconsistencies({ ...brandStock, saleRecordedAt: 'at_handover' }, 'own'),
    ).toEqual(['sale_at_handover_means_handover_is_sale']);
    expect(
      ownerPolicyInconsistencies({ ...customerStock, canSellOnline: true }, 'wholesale_customer'),
    ).toEqual(['online_needs_brand_stock']);
    // Owner ruling 2026-11-08: partner stock (sales settled through a partner) is never online,
    // though it is the brand's.
    expect(
      ownerPolicyInconsistencies(
        {
          ...brandStock,
          saleRecordedAt: 'at_sell_through',
          settlementOwnerType: 'consignment_partner',
          canSellOnline: true,
        },
        'consignment_partner',
      ),
    ).toEqual(['online_needs_brand_stock']);
    // Owner ruling 2026-11-08 ("pin it"): the consignment row always settles with its partner,
    // even with online selling off; any other row may settle with nobody.
    expect(
      ownerPolicyInconsistencies(
        {
          ...brandStock,
          saleRecordedAt: 'at_sell_through',
          settlementOwnerType: null,
          canSellOnline: false,
        },
        'consignment_partner',
      ),
    ).toEqual(['consignment_settles_with_partner']);
    expect(
      ownerPolicyInconsistencies(
        { ...customerStock, settlementOwnerType: null },
        'wholesale_customer',
      ),
    ).toEqual([]);
  });

  it('answers a raw CHECK violation of the table with its rule, and nothing else', () => {
    const check = (constraint: string, code = '23514') =>
      brokenCheckOf(Object.assign(new Error('check'), { code, constraint }));
    expect(check('location_owner_policies_online_needs_brand_stock')).toBe(
      'online_needs_brand_stock',
    );
    expect(check('location_owner_policies_handover_is_sale')).toBe(
      'handover_is_sale_means_customer_stock',
    );
    expect(check('location_owner_policies_consignment_settles_with_partner')).toBe(
      'consignment_settles_with_partner',
    );
    expect(check('location_owner_policies_sale_at_handover')).toBe(
      'sale_at_handover_means_handover_is_sale',
    );
    expect(check('orders_some_check')).toBeUndefined();
    expect(check('location_owner_policies_handover_is_sale', '23505')).toBeUndefined();
    expect(check('toString')).toBeUndefined();
  });

  it('gives every owner type a stable audit record id of its own', () => {
    const ids = LocationOwnerType.options.map((ownerType) => ownerPolicyRecordId(ownerType));
    expect(new Set(ids).size).toBe(ids.length);
    // Pinned: entries already written carry these ids, so they must never change.
    expect(ids).toEqual([
      '39acecc0-6fdb-5832-bc8b-2abdec244590',
      '326f23e9-17dc-5691-8c46-2094be2a4f3a',
      '04a2b4cf-281b-575b-82eb-2550a3738a08',
    ]);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab]/);
  });
});
