import { Body, Controller, HttpCode, Logger, Param, Post, Req, Res } from '@nestjs/common';
import {
  CancelOrderBody,
  OrderEditBody,
  OrderMoveBody,
  type OrderDetail,
  type Permission as PermissionCode,
} from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { OrderEditing } from '../editing/order-editing.service.js';
import type { OrderActor } from '../order-actor.js';
import { OrderTransactions, type OrderTransaction } from '../order-transactions.js';
import { OrderBodyPipe, orderIdPipe, ordersHttpError } from '../orders-http.js';
import { serializeOrderDetail } from '../reading/order-cost.js';
import { OrderQueries } from '../reading/order-query.service.js';
import { OrderTransitions } from '../transitions/order-transitions.service.js';

/**
 * The order moves of milestone 2 (spec 0013 API surface, AC-7 to AC-10, AC-19): edit, confirm,
 * and cancel (`orders.confirm`), pack and unpack (`fulfillment.work`), all `@Audience('staff')`
 * with one `@Permission` each. Every route takes `expectedUpdatedAt`, opens one
 * `OrderTransactions.run`, and answers the order page read in that transaction through the cost
 * serializer, `Cache-Control: no-store`. The controller declares `@RequiresModule('orders')` (core, so
 * the module gate never refuses it). Logs carry the order id and the person's id only, never a ship to
 * field.
 */
@Audience('staff')
@RequiresModule('orders')
@Controller('orders')
export class OrderMovesController {
  private readonly logger = new Logger('Orders');

  /** Takes the transaction opener, the two write services, and the read side. */
  constructor(
    private readonly transactions: OrderTransactions,
    private readonly editing: OrderEditing,
    private readonly transitions: OrderTransitions,
    private readonly queries: OrderQueries,
  ) {}

  /**
   * `POST /api/orders/:id/edits` (AC-9): one or more operations in one transaction. Line and
   * shipping operations on a gifted order also need `orders.gift` (403 `GIFT_NOT_ALLOWED`).
   */
  @Permission('orders.confirm')
  @Post(':id/edits')
  @HttpCode(200)
  edit(
    @Param('id', orderIdPipe()) id: string,
    @Body(new OrderBodyPipe(OrderEditBody)) body: z.output<typeof OrderEditBody>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDetail> {
    const mayGift = access.has('orders.gift');
    return this.move('edited', id, request, access, 'orders.confirm', response, (tx, person) =>
      this.editing.edit(tx, id, body, person, { mayGift }),
    );
  }

  /** `POST /api/orders/:id/confirm` (AC-7): `new` to `confirmed`. */
  @Permission('orders.confirm')
  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @Param('id', orderIdPipe()) id: string,
    @Body(new OrderBodyPipe(OrderMoveBody)) body: z.output<typeof OrderMoveBody>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDetail> {
    return this.move('confirmed', id, request, access, 'orders.confirm', response, (tx, person) =>
      this.transitions.confirm(tx, id, person, body.expectedUpdatedAt),
    );
  }

  /** `POST /api/orders/:id/cancel` (AC-7, AC-8): until pickup, with a reason. */
  @Permission('orders.confirm')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(
    @Param('id', orderIdPipe()) id: string,
    @Body(new OrderBodyPipe(CancelOrderBody)) body: z.output<typeof CancelOrderBody>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDetail> {
    return this.move('cancelled', id, request, access, 'orders.confirm', response, (tx, person) =>
      this.transitions.cancel(
        tx,
        id,
        { reasonCode: body.reasonCode, duplicateOfOrderId: body.duplicateOfOrderId ?? null },
        person,
        body.expectedUpdatedAt,
      ),
    );
  }

  /** `POST /api/orders/:id/pack` (AC-7): `confirmed` to `packed`; 409 `WRITE_BACK_OPEN` while a command is open. */
  @Permission('fulfillment.work')
  @Post(':id/pack')
  @HttpCode(200)
  pack(
    @Param('id', orderIdPipe()) id: string,
    @Body(new OrderBodyPipe(OrderMoveBody)) body: z.output<typeof OrderMoveBody>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDetail> {
    return this.move('packed', id, request, access, 'fulfillment.work', response, (tx, person) =>
      this.transitions.markPacked(tx, id, person, body.expectedUpdatedAt),
    );
  }

  /** `POST /api/orders/:id/unpack` (AC-7): `packed` back to `confirmed`; 409 `ORDER_LOCKED` once the delivery exists. */
  @Permission('fulfillment.work')
  @Post(':id/unpack')
  @HttpCode(200)
  unpack(
    @Param('id', orderIdPipe()) id: string,
    @Body(new OrderBodyPipe(OrderMoveBody)) body: z.output<typeof OrderMoveBody>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDetail> {
    return this.move('unpacked', id, request, access, 'fulfillment.work', response, (tx, person) =>
      this.transitions.unpack(tx, id, person, body.expectedUpdatedAt),
    );
  }

  /**
   * Runs one move in one order transaction and answers the order page as that transaction sees
   * it, through the cost serializer; maps the module's errors to their stable codes.
   */
  private async move(
    what: string,
    id: string,
    request: AuthenticatedRequest,
    access: Access,
    permission: PermissionCode,
    response: Response,
    work: (
      tx: OrderTransaction,
      person: Extract<OrderActor, { type: 'person' }>,
    ) => Promise<unknown>,
  ): Promise<OrderDetail> {
    response.setHeader('Cache-Control', 'no-store');
    const person = {
      type: 'person',
      userId: request.staff.id,
      hat: access.actingHat(permission),
    } as const;
    try {
      const detail = await this.transactions.run(async (tx) => {
        await work(tx, person);
        return this.queries.detail(id, tx);
      });
      this.logger.log(`order ${what} order=${id} person=${request.staff.id}`);
      return serializeOrderDetail(detail, access);
    } catch (error) {
      throw ordersHttpError(error, response);
    }
  }
}
