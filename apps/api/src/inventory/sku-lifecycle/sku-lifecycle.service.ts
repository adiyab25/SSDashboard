import { Inject, Injectable } from '@nestjs/common';
import type { SkuDetail, SkuUsage } from '@ssdashboard/contracts';
import type { DatabaseConnection } from '@ssdashboard/db';
import { CatalogError, CatalogService } from '../../catalog/catalog.service.js';
import { DATABASE } from '../../database/database.module.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { ledgerTransaction } from '../ledger/locks.js';

export type SkuLifecycleErrorCode = 'StockOnHand' | 'CodeLocked';

/** A stock rule a SKU action broke; the controller maps `code` to an HTTP answer. */
export class SkuLifecycleError extends Error {
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
 * The SKU actions that depend on stock state (spec 0006): code change, archive, unarchive, and
 * the usage flags. Each write checks and locks stock state through the ledger, then calls
 * `CatalogService` for the write, in one `ledgerTransaction` (lock cap, `LockTimeout` as BUSY).
 */
@Injectable()
export class SkuLifecycleService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
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
   * posting finish first, so its balance row is seen and the change answers `CodeLocked`.
   */
  async changeCode(variantId: string, code: string, updatedAt: string): Promise<SkuDetail> {
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
      return this.catalog.setCode(tx, variantId, code, updatedAt);
    });
  }

  /**
   * Admin: archives a SKU with nothing on hand and nothing reserved (AC-3). Archive and posting
   * exclude each other through the SKU row alone: this holds `FOR UPDATE` while it checks, a
   * posting (or reservation, or rebuild) holds `FOR SHARE` on the SKU until it commits.
   */
  async archive(variantId: string): Promise<SkuDetail> {
    return ledgerTransaction(this.connection.db, async (tx) => {
      if (!(await this.ledger.lockForArchive(tx, { variantId }))) throw notFound();
      const usage = (await this.ledger.usage({ variantIds: [variantId] }, tx)).get(variantId);
      if (usage?.onHandNonZero || usage?.activeReserved) {
        throw new SkuLifecycleError(
          'StockOnHand',
          'This SKU still has stock on hand or reserved. Move or adjust it first.',
        );
      }
      return this.catalog.setArchived(tx, variantId, true);
    });
  }

  /** Admin: brings an archived SKU back to search and pickers. */
  async unarchive(variantId: string): Promise<SkuDetail> {
    return ledgerTransaction(this.connection.db, async (tx) => {
      if (!(await this.ledger.lockForArchive(tx, { variantId }))) throw notFound();
      return this.catalog.setArchived(tx, variantId, false);
    });
  }
}
