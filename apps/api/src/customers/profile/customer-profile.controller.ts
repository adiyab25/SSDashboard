import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import {
  CustomerTimelineQuery,
  type CustomerProfile,
  type CustomerTimelinePage,
} from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { customerIdPipe, customersHttpError } from '../customers-http.js';
import { CustomerProfileService } from './customer-profile.service.js';
import { CustomerTimelineService } from './customer-timeline.service.js';

/**
 * `GET /api/customers/:id/timeline` and `GET /api/customers/:id` (`customers.view`, spec 0014
 * AC-4, AC-13 to AC-15), in the leaf `CustomerProfileModule`. The timeline is declared before the
 * profile. Both answers carry personal data, so they are `Cache-Control: no-store`.
 */
@Audience('staff')
@RequiresModule('customers')
@Controller('customers')
export class CustomerProfileController {
  /** Takes the profile and timeline services. */
  constructor(
    private readonly profiles: CustomerProfileService,
    private readonly timelines: CustomerTimelineService,
  ) {}

  /**
   * One page of the customer's timeline, newest first, through the viewer's lens
   * (`CUSTOMER_TIMELINE_KINDS`): kinds and guarded fields the viewer's permissions do not reach are
   * left out. 404 `CUSTOMER_NOT_FOUND`; 400 `INVALID_CURSOR` for a cursor this route did not issue,
   * `INVALID_QUERY` for any other bad query.
   */
  @Permission('customers.view')
  @Get(':id/timeline')
  async timeline(
    @Param('id', customerIdPipe()) id: string,
    @Query(new ZodQueryPipe(CustomerTimelineQuery)) query: CustomerTimelineQuery,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerTimelinePage> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.timelines.page(
        id.toLowerCase(),
        {
          limit: query.limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.kinds === undefined ? {} : { kinds: query.kinds }),
        },
        access,
      );
    } catch (error) {
      throw customersHttpError(error);
    }
  }

  /**
   * The canonical customer behind the id, with `resolvedFrom` set when the id was a merged record,
   * and for a viewer with `orders.view` the returner `signal` and the `orderCount`. 404
   * `CUSTOMER_NOT_FOUND` for an unknown or malformed id.
   */
  @Permission('customers.view')
  @Get(':id')
  async profile(
    @Param('id', customerIdPipe()) id: string,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerProfile> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.profiles.profile(id, access);
    } catch (error) {
      throw customersHttpError(error);
    }
  }
}
