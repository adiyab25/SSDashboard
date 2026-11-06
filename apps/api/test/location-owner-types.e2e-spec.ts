import { randomUUID } from 'node:crypto';
import type { LocationOwnerType } from '@ssdashboard/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocationPolicyError,
  LocationPolicyService,
  type LocationPolicy,
} from '../src/inventory/locations/location-policy.service.js';
import { LocationError, LocationsService } from '../src/inventory/locations/locations.service.js';
import {
  driftedBalances,
  fixtures,
  ledgerHarness,
  level,
  posting,
  type LedgerHarness,
} from './ledger.js';

// Spec 0002, A13 (AC-29): the three way test. One scenario runs once per seeded owner type and
// changes only which location it uses. The body below branches on policy attributes, never on the
// owner type; the owner type appears only in the table that says which location to build.
const SCENARIOS: {
  ownerType: LocationOwnerType;
  partyRole: 'is_consignment_partner' | 'is_wholesale_customer' | null;
  expected: Omit<LocationPolicy, 'ownerType'>;
}[] = [
  {
    ownerType: 'own',
    partyRole: null,
    expected: {
      stockOwnedByBrand: true,
      handoverIsSale: false,
      saleRecordedAt: 'at_shipment',
      endCustomerRefundBy: 'brand',
      defectivePieceRefundBy: 'brand',
      taxDocument: 'b2c_electronic_receipt',
      settlementOwnerType: null,
      canSellOnline: true,
    },
  },
  {
    ownerType: 'consignment_partner',
    partyRole: 'is_consignment_partner',
    expected: {
      stockOwnedByBrand: true,
      handoverIsSale: false,
      saleRecordedAt: 'at_sell_through',
      endCustomerRefundBy: 'location_owner',
      defectivePieceRefundBy: 'brand',
      taxDocument: 'b2b_electronic_invoice_at_settlement',
      settlementOwnerType: 'consignment_partner',
      canSellOnline: false,
    },
  },
  {
    ownerType: 'wholesale_customer',
    partyRole: 'is_wholesale_customer',
    expected: {
      stockOwnedByBrand: false,
      handoverIsSale: true,
      saleRecordedAt: 'at_handover',
      endCustomerRefundBy: 'location_owner',
      defectivePieceRefundBy: 'location_owner',
      taxDocument: 'b2b_electronic_invoice_at_handover',
      settlementOwnerType: null,
      canSellOnline: false,
    },
  },
];

describe('location owner types: the three way test (AC-29)', { timeout: 60_000 }, () => {
  let h: LedgerHarness;
  let make: ReturnType<typeof fixtures>;
  let policies: LocationPolicyService;
  let locations: LocationsService;
  let counter = 0;

  beforeAll(async () => {
    h = await ledgerHarness();
    make = fixtures(h.owner);
    policies = new LocationPolicyService(h.app);
    locations = new LocationsService(h.app, h.ledger, policies);
  });

  afterAll(async () => {
    await h?.close();
  });

  async function party(role: string): Promise<string> {
    counter += 1;
    const { rows } = await h.owner.pool.query<{ id: string }>(
      `INSERT INTO parties (code, name, ${role}) VALUES ($1, 'Partner', true) RETURNING id`,
      [`PT-${counter}`],
    );
    return rows[0]?.id ?? '';
  }

  async function newShop(scenario: (typeof SCENARIOS)[number]) {
    counter += 1;
    return locations.create({
      code: `SHOP-${counter}`,
      name: { en: 'Shop' },
      kind: 'shop',
      ownerType: scenario.ownerType,
      partyId: scenario.partyRole ? await party(scenario.partyRole) : undefined,
    });
  }

  async function groupsOf(sourceType: string): Promise<number> {
    const { rows } = await h.owner.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM movement_groups WHERE source_type = $1',
      [sourceType],
    );
    return rows[0]?.n ?? 0;
  }

  it.each(SCENARIOS)(
    'hands over, sells, answers the policy questions, and closes (%j)',
    async (scenario) => {
      const variantId = await make.variant();
      const warehouse = await make.location();
      const shop = await newShop(scenario);
      const policy = await policies.policyFor(shop.id);

      // The policy answers equal the seeded row.
      expect(policy).toMatchObject(scenario.expected);

      const shipmentsBefore = await groupsOf('order_shipment');
      const sellThroughsBefore = await groupsOf('consignment_sale');

      // Stock the brand's warehouse: 20 pieces at 120.0000.
      await h.ledger.post(
        posting([{ variantId, locationId: warehouse, quantity: 20, unitCost: '120.0000' }], {
          sourceType: 'purchase_receipt',
        }),
      );

      // Hand over 5 pieces: a sale when the policy says so, otherwise a transfer.
      if (policy.handoverIsSale) {
        await h.ledger.post(
          posting([{ variantId, locationId: warehouse, quantity: -5 }], {
            sourceType: 'order_shipment',
          }),
        );
        expect(await level(h.owner, { variantId, locationId: shop.id })).toMatchObject({
          onHand: 0,
        });
      } else {
        await h.ledger.post(
          posting([{ variantId, locationId: warehouse, quantity: -5 }], {
            sourceType: 'transfer_out',
          }),
        );
        await h.ledger.post(
          posting([{ variantId, locationId: shop.id, quantity: 5, unitCost: '120.0000' }], {
            sourceType: 'transfer_in',
          }),
        );
        expect(await level(h.owner, { variantId, locationId: shop.id })).toMatchObject({
          onHand: 5,
        });
      }
      expect(await level(h.owner, { variantId, locationId: warehouse })).toMatchObject({
        onHand: 15,
      });

      // One sale, recorded at the moment the policy names.
      const shipments = await groupsOf('order_shipment');
      const sellThroughs = await groupsOf('consignment_sale');
      switch (policy.saleRecordedAt) {
        case 'at_handover':
          // The handover was the sale: exactly its one shipment group, and no consignment sale.
          expect(await groupsOf('order_shipment')).toBe(shipmentsBefore + 1);
          expect(shipments).toBe(shipmentsBefore + 1);
          expect(await groupsOf('consignment_sale')).toBe(sellThroughsBefore);
          break;
        case 'at_shipment':
          await h.ledger.post(
            posting([{ variantId, locationId: shop.id, quantity: -1 }], {
              sourceType: 'order_shipment',
            }),
          );
          expect(await groupsOf('order_shipment')).toBe(shipments + 1);
          break;
        case 'at_sell_through':
          await h.ledger.post(
            posting([{ variantId, locationId: shop.id, quantity: -1 }], {
              sourceType: 'consignment_sale',
            }),
          );
          expect(await groupsOf('consignment_sale')).toBe(sellThroughs + 1);
          break;
      }

      // Closing: stock the brand still owns blocks the archive until it moves out.
      if (policy.stockOwnedByBrand) {
        await expect(locations.archive(shop.id)).rejects.toMatchObject({ code: 'StockOnHand' });
        const left = (await level(h.owner, { variantId, locationId: shop.id })).onHand;
        expect(left).toBeGreaterThan(0);
        await h.ledger.post(
          posting([{ variantId, locationId: shop.id, quantity: -left }], {
            sourceType: 'transfer_out',
          }),
        );
        await h.ledger.post(
          posting([{ variantId, locationId: warehouse, quantity: left, unitCost: '120.0000' }], {
            sourceType: 'transfer_in',
          }),
        );
      }
      const archived = await locations.archive(shop.id);
      expect(archived.archived).toBe(true);
      expect(await driftedBalances(h.owner)).toEqual([]);
    },
  );

  describe('the owner type rules at creation and update', () => {
    it('refuses online selling where the policy forbids it', async () => {
      const partner = SCENARIOS[1];
      if (!partner) throw new Error('scenario table changed');
      await expect(
        locations.create({
          code: 'NSO-1',
          name: { en: 'x' },
          kind: 'shop',
          ownerType: partner.ownerType,
          partyId: await party('is_consignment_partner'),
          sellableOnline: true,
        }),
      ).rejects.toMatchObject({ code: 'NotSellableOnline' });

      const shop = await newShop(partner);
      await expect(
        locations.update(shop.id, { updatedAt: shop.updatedAt, sellableOnline: true }),
      ).rejects.toBeInstanceOf(LocationPolicyError);
    });

    it('lets the brand own location feed online channels', async () => {
      const own = SCENARIOS[0];
      if (!own) throw new Error('scenario table changed');
      const shop = await locations.create({
        code: 'NSO-OWN',
        name: { en: 'x' },
        kind: 'shop',
        sellableOnline: true,
      });
      expect(shop).toMatchObject({ ownerType: own.ownerType, sellableOnline: true });
    });

    it('refuses a party whose role does not fit, a missing party, and a party on the brand location', async () => {
      const partner = SCENARIOS[1];
      if (!partner) throw new Error('scenario table changed');
      const wholesaler = await party('is_wholesale_customer');
      const create = (input: object) =>
        locations.create({
          code: `PRM-${randomUUID().slice(0, 8)}`,
          name: { en: 'x' },
          kind: 'shop',
          ...input,
        });
      await expect(
        create({ ownerType: partner.ownerType, partyId: wholesaler }),
      ).rejects.toMatchObject({
        code: 'PartyRoleMismatch',
      });
      await expect(create({ ownerType: partner.ownerType })).rejects.toMatchObject({
        code: 'PartyRoleMismatch',
      });
      await expect(create({ partyId: wholesaler })).rejects.toMatchObject({
        code: 'PartyRoleMismatch',
      });
    });

    it('locks the party while the location is created, so a party archived at the same moment is refused', async () => {
      const partner = SCENARIOS[1];
      if (!partner) throw new Error('scenario table changed');
      const partyId = await party('is_consignment_partner');
      const archiver = await h.owner.pool.connect();
      try {
        await archiver.query('BEGIN');
        await archiver.query('UPDATE parties SET archived_at = now() WHERE id = $1', [partyId]);

        let settled = false;
        const creating = locations
          .create({
            code: 'LOCK-1',
            name: { en: 'x' },
            kind: 'shop',
            ownerType: partner.ownerType,
            partyId,
          })
          .finally(() => {
            settled = true;
          });
        creating.catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 400));
        // The create waits for the party row instead of reading it around the lock.
        expect(settled).toBe(false);

        await archiver.query('COMMIT');
        await expect(creating).rejects.toMatchObject({ code: 'PartyRoleMismatch' });
      } finally {
        archiver.release();
      }
    });

    it('gives up with LockTimeout when the party row stays locked, instead of waiting forever', async () => {
      const partner = SCENARIOS[1];
      if (!partner) throw new Error('scenario table changed');
      const partyId = await party('is_consignment_partner');
      const holder = await h.owner.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM parties WHERE id = $1 FOR UPDATE', [partyId]);

        await expect(
          locations.create({
            code: 'LOCK-2',
            name: { en: 'x' },
            kind: 'shop',
            ownerType: partner.ownerType,
            partyId,
          }),
        ).rejects.toMatchObject({ code: 'LockTimeout' });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    });

    it('keeps the owner type fixed in the database', async () => {
      const partner = SCENARIOS[1];
      if (!partner) throw new Error('scenario table changed');
      const shop = await newShop(partner);
      await expect(
        h.owner.pool.query('UPDATE locations SET party_id = NULL, owner_type = $2 WHERE id = $1', [
          shop.id,
          SCENARIOS[0]?.ownerType,
        ]),
      ).rejects.toThrow(/OwnerTypeFixed/);
    });

    it('is a LocationError for a code clash, not a policy error', async () => {
      const own = await locations.create({ code: 'CLASH', name: { en: 'x' }, kind: 'shop' });
      await expect(
        locations.create({ code: own.code, name: { en: 'y' }, kind: 'shop' }),
      ).rejects.toBeInstanceOf(LocationError);
    });
  });
});
