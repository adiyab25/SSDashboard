import { Controller, Get } from '@nestjs/common';
import type { OnlineStatusResponse } from '@ssdashboard/contracts';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { OnlineStockService } from './online-stock.service.js';

/**
 * `GET /api/stock/online-status` (spec 0011 AC-20, `stock.view`): the online location or null, for
 * every staff page that shows "No location feeds online stock: Shopify is not being updated".
 */
@Audience('staff')
@RequiresModule('inventory')
@Controller('stock')
export class OnlineStatusController {
  /** Takes the online stock service. */
  constructor(private readonly onlineStock: OnlineStockService) {}

  /** The online location (`{ id, code, name }`), or `{ onlineLocation: null }`. */
  @Permission('stock.view')
  @Get('online-status')
  async status(): Promise<OnlineStatusResponse> {
    return { onlineLocation: await this.onlineStock.onlineLocation() };
  }
}
