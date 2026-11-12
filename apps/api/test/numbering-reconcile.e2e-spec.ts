import { CatalogService } from '../src/catalog/catalog.service.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReconciliationService } from '../src/inventory/ledger/reconciliation.service.js';
import { NumberingError, NumberingService } from '../src/platform/numbering.service.js';
import { SettingsService } from '../src/platform/settings/settings.service.js';
import { driftedBalances, fixtures, ledgerHarness, posting, type LedgerHarness } from './ledger.js';

// Spec 0002, Milestone 4: document numbering and the nightly reconciliation, against PostgreSQL.
describe('numbering and reconciliation', { timeout: 60_000 }, () => {
  let h: LedgerHarness;
  let make: ReturnType<typeof fixtures>;
  let numbering: NumberingService;
  let reconciliation: ReconciliationService;

  beforeAll(async () => {
    h = await ledgerHarness();
    make = fixtures(h.owner);
    numbering = new NumberingService(new SettingsService(h.app));
    reconciliation = new ReconciliationService(h.app, new CatalogService(h.app));
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('document numbers (AC-10)', () => {
    class Rollback extends Error {}

    it('issues gap free numbers under concurrency, giving back rolled back ones', async () => {
      const date = new Date('2028-06-15T10:00:00Z');

      const results = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) =>
          h.app.db.transaction(async (tx) => {
            const number = await numbering.next(tx, 'PO', date);
            if (i % 10 === 0) throw new Rollback();
            return number;
          }),
        ),
      );

      const issued = results
        .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort();
      expect(issued).toHaveLength(45);
      expect(issued).toEqual(
        Array.from({ length: 45 }, (_, i) => `PO-2028-${String(i + 1).padStart(6, '0')}`),
      );
    });

    it('starts each year at 000001, with the year taken in Cairo time', async () => {
      // 23:30 UTC on 31 December is already 1 January in Cairo.
      const number = await numbering.next(h.app.db, 'SO', new Date('2030-12-31T23:30:00Z'));

      expect(number).toBe('SO-2031-000001');
    });

    it('keeps issued numbers when the prefix changes later', async () => {
      const date = new Date('2029-03-01T10:00:00Z');
      const before = await numbering.next(h.app.db, 'GRN', date);
      await h.owner.pool.query(
        `UPDATE settings SET value = jsonb_set(value, '{GRN}', '"RCV"') WHERE key = 'document_prefixes'`,
      );

      const after = await numbering.next(h.app.db, 'GRN', date);

      expect(before).toBe('GRN-2029-000001');
      expect(after).toBe('RCV-2029-000002');
    });

    it('rejects a document type without a prefix', async () => {
      await expect(numbering.next(h.app.db, 'XYZ', new Date())).rejects.toBeInstanceOf(
        NumberingError,
      );
    });
  });

  describe('reconciliation (AC-11)', () => {
    async function openDiscrepancies(kind: string) {
      const { rows } = await h.owner.pool.query<{ id: string; expected: unknown; actual: unknown }>(
        `SELECT id, expected, actual FROM stock_level_discrepancies
         WHERE kind = $1 AND resolved_at IS NULL`,
        [kind],
      );
      return rows;
    }

    it('finds nothing while postings run during the check', async () => {
      const key = { variantId: await make.variant(), locationId: await make.location() };
      await h.ledger.post(posting([{ ...key, quantity: 100, unitCost: '1.2345' }]));

      const [found] = await Promise.all([
        reconciliation.reconcile(),
        ...Array.from({ length: 20 }, (_, i) =>
          h.ledger.post(
            posting([{ ...key, quantity: i % 2 ? 3 : -2, unitCost: i % 2 ? '2.5' : undefined }]),
          ),
        ),
      ]);

      expect(found).toBe(0);
      expect(await reconciliation.reconcile()).toBe(0);
    });

    it('records a drifted balance once across runs, and an approved rebuild fixes it', async () => {
      const key = { variantId: await make.variant(), locationId: await make.location() };
      await h.ledger.post(posting([{ ...key, quantity: 5, unitCost: '2.0000' }]));
      // Test only: the owner role edits a balance behind the ledger's back.
      await h.owner.pool.query(
        'UPDATE stock_levels SET on_hand = 7, total_value = 15.00 WHERE variant_id = $1',
        [key.variantId],
      );

      expect(await reconciliation.reconcile()).toBe(1);
      expect(await reconciliation.reconcile()).toBe(1);
      const open = await openDiscrepancies('balance');
      expect(open.map(({ expected, actual }) => ({ expected, actual }))).toEqual([
        {
          expected: { onHand: 5, totalValue: '10.00' },
          actual: { onHand: 7, totalValue: '15.00' },
        },
      ]);
      const discrepancyId = open[0]?.id ?? '';
      const admin = randomUUID();

      const rebuilt = await reconciliation.rebuildLevel({ discrepancyId, resolvedBy: admin });

      expect(rebuilt).toMatchObject({ onHand: 5, totalValue: '10.00', avgUnitCost: '2.0000' });
      const { rows } = await h.owner.pool.query(
        `SELECT resolved_by, resolution, resolved_at IS NOT NULL AS resolved
         FROM stock_level_discrepancies WHERE id = $1`,
        [discrepancyId],
      );
      expect(rows).toEqual([{ resolved_by: admin, resolution: 'rebuilt', resolved: true }]);
      expect(await driftedBalances(h.owner)).toEqual([]);
      expect(await reconciliation.reconcile()).toBe(0);
      await expect(
        reconciliation.rebuildLevel({ discrepancyId, resolvedBy: admin }),
      ).rejects.toMatchObject({ code: 'DiscrepancyClosed' });
    });

    it('finds a serial count that differs from on hand', async () => {
      const variantId = await make.variant({ tracking: 'serial' });
      const locationId = await make.location();
      await h.ledger.post(
        posting([{ variantId, locationId, quantity: 2, unitCost: '1', serials: ['Q1', 'Q2'] }]),
      );
      await h.owner.pool.query(
        `UPDATE serials SET status = 'out', location_id = NULL WHERE variant_id = $1 AND serial = 'Q1'`,
        [variantId],
      );
      try {
        expect(await reconciliation.reconcile()).toBe(1);
        expect(
          (await openDiscrepancies('serial')).map(({ expected, actual }) => ({ expected, actual })),
        ).toEqual([{ expected: { inStockSerials: 2 }, actual: { inStockSerials: 1 } }]);
        // A balance rebuild cannot fix a serial count, so it refuses and leaves it open.
        const [open] = await openDiscrepancies('serial');
        await expect(
          reconciliation.rebuildLevel({ discrepancyId: open?.id ?? '', resolvedBy: randomUUID() }),
        ).rejects.toMatchObject({ code: 'NotRebuildable' });
        expect(await openDiscrepancies('serial')).toHaveLength(1);
      } finally {
        await h.owner.pool.query(
          `UPDATE serials SET status = 'in_stock', location_id = $2 WHERE variant_id = $1`,
          [variantId, locationId],
        );
      }
    });

    it('finds reservations larger than on hand where stock cannot go negative', async () => {
      const key = { variantId: await make.variant(), locationId: await make.location() };
      await h.ledger.post(posting([{ ...key, quantity: 2, unitCost: '1' }]));
      const { rows } = await h.owner.pool.query<{ id: string }>(
        `INSERT INTO reservations (variant_id, location_id, quantity, open_quantity, source_type,
                                   source_id, source_line_id)
         VALUES ($1, $2, 9, 9, 'sales_order', gen_random_uuid(), gen_random_uuid()) RETURNING id`,
        [key.variantId, key.locationId],
      );
      try {
        expect(await reconciliation.reconcile()).toBe(1);
        expect(
          (await openDiscrepancies('reservation')).map(({ expected, actual }) => ({
            expected,
            actual,
          })),
        ).toEqual([{ expected: { maxReserved: 2 }, actual: { reserved: 9 } }]);
      } finally {
        await h.owner.pool.query('DELETE FROM reservations WHERE id = $1', [rows[0]?.id]);
      }
    });

    it('fails a rebuild with LockTimeout while the balance is held, then rebuilds once free', async () => {
      const key = { variantId: await make.variant(), locationId: await make.location() };
      await h.ledger.post(posting([{ ...key, quantity: 5, unitCost: '1.0000' }]));
      await h.owner.pool.query('UPDATE stock_levels SET on_hand = 6 WHERE variant_id = $1', [
        key.variantId,
      ]);
      await reconciliation.reconcile();
      const { rows } = await h.owner.pool.query<{ id: string }>(
        `SELECT id FROM stock_level_discrepancies
         WHERE kind = 'balance' AND variant_id = $1 AND resolved_at IS NULL`,
        [key.variantId],
      );
      const discrepancyId = rows[0]?.id ?? '';
      const blocker = await h.owner.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT 1 FROM stock_levels WHERE variant_id = $1 FOR UPDATE', [
          key.variantId,
        ]);

        await expect(
          reconciliation.rebuildLevel({ discrepancyId, resolvedBy: randomUUID() }),
        ).rejects.toMatchObject({ code: 'LockTimeout' });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }

      const rebuilt = await reconciliation.rebuildLevel({
        discrepancyId,
        resolvedBy: randomUUID(),
      });

      expect(rebuilt).toMatchObject({ onHand: 5, totalValue: '5.00' });
    });
  });
});
