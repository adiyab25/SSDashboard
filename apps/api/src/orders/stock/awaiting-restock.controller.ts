import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  CloseAwaitingRestockBody,
  RestockAwaitingBody,
  type OrderDetail,
} from '@ssdashboard/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { forbidden } from '../../platform/access/permission.guard.js';
import { AnyHat, Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { OrderTransactions } from '../order-transactions.js';
import { OrderBodyPipe, orderIdPipe, ordersHttpError } from '../orders-http.js';
import { OrderStale } from '../orders.errors.js';
import { serializeOrderDetail } from '../reading/order-cost.js';
import { OrderQueries } from '../reading/order-query.service.js';
import { OrderStock } from './order-stock.js';

/** The `Idempotency-Key` of a restock: a uuid the page makes once per action. */
const IdempotencyKey = z.uuid();

/** A malformed line id names no line that awaits restock: 409 `NOTHING_AWAITING`. */
const lineIdPipe = (): ParseUUIDPipe =>
  new ParseUUIDPipe({
    exceptionFactory: () =>
      new ConflictException({
        code: 'NOTHING_AWAITING',
        message: 'Fewer pieces of this line await restock than that',
      }),
  });

/**
 * The awaiting restock routes of the order page (spec 0013 AC-27 e, f, API surface), audience
 * `staff`, module `orders`:
 *
 * - `POST /api/orders/:id/lines/:lineId/restock` ("Received on the shelf", `stock.receive`): the
 *   `Idempotency-Key` uuid header (400 `IDEMPOTENCY_KEY_REQUIRED` without one) and a quantity; puts
 *   that many awaiting pieces back on the shelf through `OrderStock.restockAwaiting` (409
 *   `NOTHING_AWAITING`, `IDEMPOTENCY_CONFLICT`; 422 `PERIOD_LOCKED`; 503 `BUSY`).
 * - `POST /api/orders/:id/lines/:lineId/close-awaiting-restock` (`@AnyHat()`, checked in the
 *   handler through `Access`): a `stock.correct` holder closes pieces that never come back, a
 *   `stock.receive` holder without it asks a manager to (403 `FORBIDDEN` for neither; 409
 *   `NOTHING_AWAITING`, `STALE_RECORD`, `CLOSE_ALREADY_REQUESTED` while a request is open; 422
 *   `INVALID_BODY`). The permission is checked before
 *   the body is read, so a hat with neither always gets 403.
 *
 * Each answers the order page through the cost serializer, `Cache-Control: no-store`. Logs carry
 * the order, line, and person ids only.
 */
@Audience('staff')
@RequiresModule('orders')
@Controller('orders')
export class AwaitingRestockController {
  private readonly logger = new Logger('Orders');

  /** Takes the transaction opener, the stock seam, and the read side. */
  constructor(
    private readonly transactions: OrderTransactions,
    private readonly stock: OrderStock,
    private readonly queries: OrderQueries,
  ) {}

  /** "Received on the shelf": puts `quantity` awaiting pieces of the line back in stock. */
  @Permission('stock.receive')
  @Post(':id/lines/:lineId/restock')
  @HttpCode(200)
  async restock(
    @Param('id', orderIdPipe()) id: string,
    @Param('lineId', lineIdPipe()) lineId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new OrderBodyPipe(RestockAwaitingBody)) body: z.output<typeof RestockAwaitingBody>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDetail> {
    response.setHeader('Cache-Control', 'no-store');
    const idempotencyKey = IdempotencyKey.safeParse(key);
    if (!idempotencyKey.success) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Send an Idempotency-Key header holding a UUID',
      });
    }
    const person = {
      type: 'person',
      userId: request.staff.id,
      hat: access.actingHat('stock.receive'),
    } as const;
    try {
      const result = await this.stock.restockAwaiting(
        id,
        lineId,
        body.quantity,
        idempotencyKey.data.toLowerCase(),
        person,
        'received_on_shelf',
      );
      this.logger.log(
        `awaiting pieces restocked order=${id} line=${lineId} person=${request.staff.id} replayed=${String(result.replayed)}`,
      );
      return serializeOrderDetail(await this.queries.detail(id), access);
    } catch (error) {
      throw ordersHttpError(error, response);
    }
  }

  /** Closes pieces that never come back (`stock.correct`), or asks for it (`stock.receive`). */
  @AnyHat()
  @Post(':id/lines/:lineId/close-awaiting-restock')
  @HttpCode(200)
  async close(
    @Param('id', orderIdPipe()) id: string,
    @Param('lineId', lineIdPipe()) lineId: string,
    @Body() raw: unknown,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDetail> {
    response.setHeader('Cache-Control', 'no-store');
    const mayClose = access.has('stock.correct');
    if (!mayClose && !access.has('stock.receive')) throw forbidden();
    const body = new OrderBodyPipe(CloseAwaitingRestockBody).transform(raw);
    const person = {
      type: 'person',
      userId: request.staff.id,
      hat: access.actingHat(mayClose ? 'stock.correct' : 'stock.receive'),
    } as const;
    try {
      const detail = await this.transactions.run(async (tx) => {
        await this.stock.closeAwaiting(tx, id, lineId, body, person, mayClose);
        return this.queries.detail(id, tx);
      });
      this.logger.log(
        `awaiting pieces ${mayClose ? 'closed' : 'close requested'} order=${id} line=${lineId} person=${request.staff.id}`,
      );
      return serializeOrderDetail(detail, access);
    } catch (error) {
      if (error instanceof OrderStale) {
        throw new ConflictException({ code: 'STALE_RECORD', message: error.message });
      }
      throw ordersHttpError(error, response);
    }
  }
}
