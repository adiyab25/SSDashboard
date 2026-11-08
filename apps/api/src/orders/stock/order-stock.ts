import { Injectable } from '@nestjs/common';
import type { OrderTransaction } from '../order-transactions.js';

/** The lines an edit took out and put in, by order line id. */
export interface EditedLines {
  addedLineIds: readonly string[];
  cancelledLineIds: readonly string[];
}

/**
 * The orders module's seam to the stock ledger (spec 0013 AC-13, `stock/order-stock.ts`). Every
 * move that holds or frees stock already calls it at the right point in its transaction, so
 * milestone 4 fills these bodies with spec 0011's `reserveLines` (`shortage: 'reserve_available'`),
 * `releaseLines`, and `releaseSource` and writes `short_quantity` from the answers, without moving
 * a call site. Until then each method does nothing: milestone 2 makes no stock call, takes no
 * reservation, and never answers `LINE_SHORT`. It must never write an order table itself.
 */
@Injectable()
export class OrderStock {
  /**
   * After an order is created (AC-13: reserve at creation): milestone 4 reserves every line with a
   * variant at the online location. The caller never calls it for an order created past `packed`
   * or cancelled (an import in its found states, AC-14). A no op until then.
   */
  afterCreate(_tx: OrderTransaction, _orderId: string, _lineIds: readonly string[]): Promise<void> {
    return Promise.resolve();
  }

  /**
   * After `linkChannelLineVariant` mapped a line of an order still in `new`, `confirmed`, or
   * `packed` (AC-25 b): milestone 4 reserves that line. A no op until then.
   */
  afterLink(_tx: OrderTransaction, _orderId: string, _lineId: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * After an edit (AC-13): milestone 4 releases the reservations of the cancelled lines and
   * reserves the added ones. A no op until then.
   */
  afterEdit(_tx: OrderTransaction, _orderId: string, _lines: EditedLines): Promise<void> {
    return Promise.resolve();
  }

  /**
   * After a cancel (AC-7, AC-13): milestone 4 releases every reservation of the order
   * (`releaseSource`). A no op until then.
   */
  afterCancel(_tx: OrderTransaction, _orderId: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * On confirm and before pack (AC-13): milestone 4 tops the order's short lines up with
   * `reserveLines` and, for a pack, refuses a line still short with `LineShort` (409
   * `LINE_SHORT`). A no op until then.
   */
  topUp(_tx: OrderTransaction, _orderId: string, _forPacking: boolean): Promise<void> {
    return Promise.resolve();
  }
}
