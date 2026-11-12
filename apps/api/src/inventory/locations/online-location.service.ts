import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  STOCK_COUNTED_CHECK_KEY,
  personActor,
  type LocationDetail,
  type OnlineGateCheck,
  type OnlineGateView,
  type StopOnlineResponse,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, pgConstraint, type Executor, type Transaction } from '../../database/sql.js';
import { ledgerTransaction } from '../ledger/locks.js';
import { OnlineStockGate } from '../online-stock/online-stock-gate.js';
import { OnlineStockService } from '../online-stock/online-stock.service.js';
import { LocationPolicyService } from './location-policy.service.js';
import { LocationError, LocationsService, type LocationCaller } from './locations.service.js';

const logger = new Logger('OnlineLocation');

/** The facts of a location the gate decides on. */
interface GateLocationRow extends Record<string, unknown> {
  code: string;
  kind: 'warehouse' | 'shop';
  is_sellable: boolean;
  archived: boolean;
  stock_verified_at: string | null;
}

/** The gate's built in check: the location's stock is confirmed counted (`stock_verified_at` set). */
function stockCountedCheck(row: GateLocationRow, variantsWithStock: number): OnlineGateCheck {
  return {
    key: STOCK_COUNTED_CHECK_KEY,
    label: 'inventory.onlineGate.checks.stockCounted',
    passed: row.stock_verified_at !== null,
    count: variantsWithStock,
  };
}

/**
 * The gated actions that decide which location feeds online stock (spec 0011 AC-1, AC-19): read
 * the gate, confirm a location's stock counted, move the online flag, and stop it. It is the only
 * writer of `sellable_online` besides the archive that clears it. The flag moves in one
 * transaction under `FOR UPDATE` on both location rows, with the database's partial unique index
 * as the last guard; it never reads another module's tables (other modules' checks come through
 * `OnlineStockGate`) and never moves stock.
 */
@Injectable()
export class OnlineLocationService {
  /** Takes the connection, the online stock read, the gate registry, and the services it asks. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(OnlineStockService) private readonly onlineStock: OnlineStockService,
    @Inject(OnlineStockGate) private readonly gate: OnlineStockGate,
    @Inject(LocationPolicyService) private readonly policy: LocationPolicyService,
    @Inject(LocationsService) private readonly locations: LocationsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * What the gate reports for a location (spec 0011 AC-19): the built in check, every registered
   * check, the counts to confirm, and the reservations that stay at the current online location.
   * Throws `NotFound` for a missing or system location.
   */
  async gateFor(
    locationId: string,
    executor: Executor = this.connection.db,
  ): Promise<OnlineGateView> {
    const row = await this.rowOf(executor, locationId);
    if (!row) throw new LocationError('NotFound', 'Location not found');
    const counts = await this.onlineStock.gateCounts(locationId, executor);
    const checks = [
      stockCountedCheck(row, counts.variantsWithStock),
      ...(await this.gate.evaluate(locationId, executor)),
    ];
    const current = await this.onlineStock.onlineLocation(executor);
    const eligible =
      row.kind === 'warehouse' &&
      row.is_sellable &&
      !row.archived &&
      (await this.policy.policyFor(locationId, executor)).canSellOnline;
    return {
      canGoOnline: eligible && checks.every((check) => check.passed),
      checks,
      ...counts,
      reservationsAtOldLocation:
        current && current.id !== locationId
          ? await this.onlineStock.activeReservations(current.id, executor)
          : 0,
      currentOnlineLocation: current,
    };
  }

  /**
   * Confirms a location's stock counted (`location.stock_confirmed`): the gate's "stock counted"
   * fact. `AlreadyConfirmed` when it was already, `NotFound` for a missing location.
   */
  async confirmStock(
    locationId: string,
    reason: string | undefined,
    caller: LocationCaller,
  ): Promise<LocationDetail> {
    const correlationId = this.audit.newCorrelationId();
    return ledgerTransaction(this.connection.db, async (tx) => {
      const before = await this.locations.detailOf(tx, locationId);
      if (!before) throw new LocationError('NotFound', 'Location not found');
      if (!(await this.locations.recordStockVerified(tx, locationId, caller.id))) {
        throw new LocationError('AlreadyConfirmed', "This location's stock is already confirmed");
      }
      await this.audit.record(tx, {
        actor: personActor(caller.id, caller.access.actingHat('catalog.manage')),
        action: 'location.stock_confirmed',
        record: { type: 'location', id: locationId, label: before.code },
        before: { stockVerified: false },
        after: { stockVerified: true },
        ...(reason ? { reason } : {}),
        correlationId,
      });
      const after = await this.locations.detailOf(tx, locationId);
      if (!after) throw new Error('The confirmed location vanished');
      return after;
    });
  }

  /**
   * Makes a location the online one (`location.online_moved`, reason required): in one
   * transaction the old online location goes off and this one on. Refuses a location that is not
   * an active sellable warehouse (`OnlineNeedsWarehouse`), an owner type that may not sell online
   * (`NotSellableOnline`), a failed check (`OnlineGateFailed`, with the failed keys), and a count
   * that no longer matches the variants with stock, or a flag someone else moved meanwhile
   * (`OnlineGateStale`). Reservations left at the old location stay there.
   */
  async makeOnline(
    locationId: string,
    input: { confirmedVariantCount: number; reason?: string },
    caller: LocationCaller,
  ): Promise<LocationDetail> {
    const correlationId = this.audit.newCorrelationId();
    try {
      return await ledgerTransaction(this.connection.db, async (tx) => {
        const first = await this.rowOf(tx, locationId);
        if (!first) throw new LocationError('NotFound', 'Location not found');
        const seen = await this.onlineStock.onlineLocation(tx);
        const ids = [...new Set([locationId, seen?.id ?? locationId])].sort();
        await tx.execute(sql`
          SELECT id FROM locations WHERE id = ANY(${pgArray(ids)}::uuid[]) ORDER BY id FOR UPDATE`);
        const current = await this.onlineStock.onlineLocation(tx);
        if ((current?.id ?? null) !== (seen?.id ?? null)) throw stale();
        if (current?.id === locationId) {
          throw new LocationError('AlreadyOnline', 'This location already feeds online stock');
        }
        const row = await this.rowOf(tx, locationId);
        if (!row) throw new LocationError('NotFound', 'Location not found');
        if (row.kind !== 'warehouse' || !row.is_sellable || row.archived) {
          throw new LocationError(
            'OnlineNeedsWarehouse',
            'Only an active, sellable warehouse can feed online stock',
          );
        }
        await this.policy.assertCanSellOnline(locationId, tx);
        const view = await this.gateFor(locationId, tx);
        const failed = view.checks.filter((check) => !check.passed).map((check) => check.key);
        if (failed.length) {
          throw new LocationError('OnlineGateFailed', 'The online gate has failing checks', {
            failedKeys: failed,
          });
        }
        if (input.confirmedVariantCount !== view.variantsWithStock) throw stale();
        if (current) {
          await tx.execute(sql`
            UPDATE locations SET sellable_online = false, updated_at = now() WHERE id = ${current.id}`);
        }
        await tx.execute(sql`
          UPDATE locations SET sellable_online = true, updated_at = now() WHERE id = ${locationId}`);
        await this.audit.record(tx, {
          actor: personActor(caller.id, caller.access.actingHat('catalog.manage')),
          action: 'location.online_moved',
          record: { type: 'location', id: locationId, label: row.code },
          before: { online: false, onlineLocationId: current?.id ?? null },
          after: {
            online: true,
            variantsWithStock: view.variantsWithStock,
            reservationsLeftAtOldLocation: view.reservationsAtOldLocation,
          },
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          correlationId,
        });
        const detail = await this.locations.detailOf(tx, locationId);
        if (!detail) throw new Error('The online location vanished');
        logger.log(
          `online_location.moved to=${locationId} from=${current?.id ?? 'none'} variants=${view.variantsWithStock}`,
        );
        return detail;
      });
    } catch (error) {
      // The partial unique index is the last guard: a second flag set at the same moment.
      if (pgConstraint(error) === 'locations_one_online') throw stale();
      throw error;
    }
  }

  /**
   * Turns online stock off (`location.online_stopped`, reason required): no location feeds it
   * afterwards and the Shopify connector pushes nothing. `NoOnlineLocation` when none is online.
   */
  async stop(reason: string | undefined, caller: LocationCaller): Promise<StopOnlineResponse> {
    const correlationId = this.audit.newCorrelationId();
    return ledgerTransaction(this.connection.db, async (tx) => {
      const { rows } = await tx.execute<{ id: string; code: string }>(sql`
        SELECT id, code FROM locations WHERE sellable_online AND archived_at IS NULL FOR UPDATE`);
      const current = rows[0];
      if (!current) {
        throw new LocationError('NoOnlineLocation', 'No location feeds online stock');
      }
      await tx.execute(sql`
        UPDATE locations SET sellable_online = false, updated_at = now() WHERE id = ${current.id}`);
      await this.audit.record(tx, {
        actor: personActor(caller.id, caller.access.actingHat('catalog.manage')),
        action: 'location.online_stopped',
        record: { type: 'location', id: current.id, label: current.code },
        before: { online: true },
        after: { online: false },
        ...(reason !== undefined ? { reason } : {}),
        correlationId,
      });
      logger.log(`online_location.stopped location=${current.id}`);
      return { onlineLocation: null };
    });
  }

  private async rowOf(
    executor: Executor | Transaction,
    id: string,
  ): Promise<GateLocationRow | null> {
    const { rows } = await executor.execute<GateLocationRow>(sql`
      SELECT code, kind, is_sellable, archived_at IS NOT NULL AS archived,
             stock_verified_at::text AS stock_verified_at
      FROM locations WHERE id = ${id} AND kind IN ('warehouse', 'shop')`);
    return rows[0] ?? null;
  }
}

const stale = () =>
  new LocationError(
    'OnlineGateStale',
    'The stock or the online location changed since the gate was read. Read it again.',
  );
