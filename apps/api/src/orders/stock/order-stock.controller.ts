import { Body, Controller, HttpCode, Logger, Post, Req, Res } from '@nestjs/common';
import { HoldOpenOrdersBody, type HoldOpenOrdersResult } from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { OrderBodyPipe, ordersHttpError } from '../orders-http.js';
import { OrderStock } from './order-stock.js';

/**
 * The orders route of the online gate (spec 0013 AC-26, AC-19):
 * `POST /api/orders/hold-open-orders`, audience `staff`, permission `catalog.manage` (the
 * location manager's), module `orders`. It reserves the open orders' lines at the location that
 * is about to feed online stock and answers the counts, `Cache-Control: no-store`. Logs carry the
 * location id and the person's id only.
 */
@Audience('staff')
@RequiresModule('orders')
@Controller('orders')
export class OrderStockController {
  private readonly logger = new Logger('Orders');

  /** Takes the orders stock seam. */
  constructor(private readonly stock: OrderStock) {}

  /**
   * Holds every open order line at `locationId` (404 `LOCATION_NOT_FOUND` for a missing, archived,
   * or never online location; 503 `BUSY` with `Retry-After` when a batch waits too long).
   */
  @Permission('catalog.manage')
  @Post('hold-open-orders')
  @HttpCode(200)
  async holdOpenOrders(
    @Body(new OrderBodyPipe(HoldOpenOrdersBody)) body: z.output<typeof HoldOpenOrdersBody>,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<HoldOpenOrdersResult> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const result = await this.stock.holdOpenOrdersAt(body.locationId);
      this.logger.log(
        `Open orders held at location ${body.locationId} by ${request.staff.id}: ${String(result.linesHeld)} held, ${String(result.linesShort)} short, ${String(result.linesLeft)} left`,
      );
      return result;
    } catch (error) {
      throw ordersHttpError(error, response);
    }
  }
}
