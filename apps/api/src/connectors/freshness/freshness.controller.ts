import { Controller, Get } from '@nestjs/common';
import type { ConnectionFreshnessResponse } from '@ssdashboard/contracts';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { FreshnessService } from './freshness.service.js';

/**
 * `GET /api/connections/freshness` (spec 0015 AC-18, *API surface*): the back office shell's
 * freshness line, read once a minute by every hat with `orders.view`. Registered before
 * `ConnectionsController` (`ConnectorsModule` lists it first), so its path is never taken for a
 * connection id. Answers `ConnectionFreshnessResponse`; never a credential or personal data.
 */
@Audience('staff')
@RequiresModule('connectors')
@Permission('orders.view')
@Controller('connections/freshness')
export class FreshnessController {
  /** Takes the freshness service. */
  constructor(private readonly freshness: FreshnessService) {}

  /** Every active connection's freshness (see `FreshnessService`). */
  @Get()
  async read(): Promise<ConnectionFreshnessResponse> {
    return this.freshness.freshness();
  }
}
