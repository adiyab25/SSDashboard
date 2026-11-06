import { Inject, Injectable } from '@nestjs/common';
import { personActor, type SkuDetail, type SkuUsage, type StaffRole } from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { AuditService } from '../../audit/audit.service.js';
import { CatalogError, CatalogService } from '../../catalog/catalog.service.js';
import { DATABASE } from '../../database/database.module.js';
import type { Transaction } from '../../database/sql.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { ledgerTransaction } from '../ledger/locks.js';

/**
 * The stock rules a SKU action can break: stock is on hand, or the code is locked because stock
 * was posted.
 */
export type SkuLifecycleErrorCode = 'StockOnHand' | 'CodeLocked';

/** A stock rule a SKU action broke; the controller maps `code` to an HTTP answer. */
export class SkuLifecycleError extends Error {
  /** Takes the stable `code` the controller maps to an HTTP answer, and a message safe to show. */
  constructor(
    readonly code: SkuLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SkuLifecycleError';
  }
}

const notFound = () => new CatalogError('NotFound', 'SKU not found');

/**
 * The signed in admin acting on a SKU. `role` is recorded as the audit actor's hat until hats
 * reach the session (spec 0008).
 */
export interface SkuCaller {
  id: string;
  role: StaffRole;
}

/**
 * The SKU actions that depend on stock state (spec 0006): code change, archive, unarchive, and
 * the usage flags. Each write checks and locks stock state through the ledger, then calls
 * `CatalogService` for the write, in one `ledgerTransaction` (lock cap, `LockTimeout` as BUSY),
 * and records its audit entry in that same transaction when the SKU changed (spec 0010, AC-11).
 */
@Injectable()
export class SkuLifecycleService {
  /**
   * Takes the app database connection, the ledger (for stock state and locks), the catalog (for
   * the write), and the audit service (for the entry).
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** `codeLocked` once any balance row exists; `canArchive` while nothing is on hand or held. */
  async usage(variantId: string): Promise<SkuUsage> {
    await this.catalog.getSku(variantId);
    const usage = (await this.ledger.usage({ variantIds: [variantId] })).get(variantId);
    return {
      codeLocked: usage?.hasBalance ?? false,
      canArchive: !(usage?.onHandNonZero ?? false) && !(usage?.activeReserved ?? false),
    };
  }

  /**
   * Admin: a new code while the SKU was never posted (AC-2). The row lock makes an in flight
   * posting finish first, so its balance row is seen and the change answers `CodeLocked`. A real
   * change records `sku.code_changed` with the old and new code.
   */
  async changeCode(
    variantId: string,
    code: string,
    updatedAt: string,
    caller: SkuCaller,
  ): Promise<SkuDetail> {
    const correlationId = this.audit.newCorrelationId();
    return ledgerTransaction(this.connection.db, async (tx) => {
      if (!(await this.ledger.lockForArchive(tx, { variantId }))) throw notFound();
      const usage = (await this.ledger.usage({ variantIds: [variantId] }, tx)).get(variantId);
      const current = await this.catalog.getSkus([variantId], tx);
      if (usage?.hasBalance && current.get(variantId)?.code !== code) {
        throw new SkuLifecycleError(
          'CodeLocked',
          'Stock was posted for this SKU, so its code cannot change',
        );
      }
      const before = current.get(variantId)?.code;
      const sku = await this.catalog.setCode(tx, variantId, code, updatedAt);
      if (before !== undefined && before !== sku.code) {
        await this.audit.record(tx, {
          actor: personActor(caller.id, caller.role),
          action: 'sku.code_changed',
          record: { type: 'sku', id: variantId, label: sku.code },
          before: { code: before },
          after: { code: sku.code },
          correlationId,
        });
      }
      return sku;
    });
  }

  /**
   * Admin: archives a SKU with nothing on hand and nothing reserved (AC-3). Archive and posting
   * exclude each other through the SKU row alone: this holds `FOR UPDATE` while it checks, a
   * posting (or reservation, or rebuild) holds `FOR SHARE` on the SKU until it commits. Archiving
   * an active SKU records `sku.archived`.
   */
  async archive(variantId: string, caller: SkuCaller): Promise<SkuDetail> {
    const correlationId = this.audit.newCorrelationId();
    return ledgerTransaction(this.connection.db, async (tx) => {
      const locked = await this.ledger.lockForArchive(tx, { variantId });
      if (!locked) throw notFound();
      const usage = (await this.ledger.usage({ variantIds: [variantId] }, tx)).get(variantId);
      if (usage?.onHandNonZero || usage?.activeReserved) {
        throw new SkuLifecycleError(
          'StockOnHand',
          'This SKU still has stock on hand or reserved. Move or adjust it first.',
        );
      }
      const sku = await this.catalog.setArchived(tx, variantId, true);
      if (!locked.archived) await this.recordArchive(tx, sku, true, caller, correlationId);
      return sku;
    });
  }

  /** Admin: brings an archived SKU back to search and pickers, recording `sku.unarchived`. */
  async unarchive(variantId: string, caller: SkuCaller): Promise<SkuDetail> {
    const correlationId = this.audit.newCorrelationId();
    return ledgerTransaction(this.connection.db, async (tx) => {
      const locked = await this.ledger.lockForArchive(tx, { variantId });
      if (!locked) throw notFound();
      const sku = await this.catalog.setArchived(tx, variantId, false);
      if (locked.archived) await this.recordArchive(tx, sku, false, caller, correlationId);
      return sku;
    });
  }

  /** The archive or unarchive entry: `archived` before and after, labelled with the SKU code. */
  private async recordArchive(
    tx: Transaction,
    sku: SkuDetail,
    archived: boolean,
    caller: SkuCaller,
    correlationId: string,
  ): Promise<void> {
    await this.audit.record(tx, {
      actor: personActor(caller.id, caller.role),
      action: archived ? 'sku.archived' : 'sku.unarchived',
      record: { type: 'sku', id: sku.id, label: sku.code },
      before: { archived: !archived },
      after: { archived },
      correlationId,
    });
  }
}
