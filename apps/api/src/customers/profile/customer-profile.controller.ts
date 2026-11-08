import { Controller, Get, Param, Res } from '@nestjs/common';
import type { CustomerProfile } from '@ssdashboard/contracts';
import type { Response } from 'express';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { customerIdPipe, customersHttpError } from '../customers-http.js';
import { CustomerProfileService } from './customer-profile.service.js';

/** `GET /api/customers/:id` (`customers.view`, spec 0014 AC-4). */
@Audience('staff')
@Controller('customers')
export class CustomerProfileController {
  /** Takes the profile service. */
  constructor(private readonly profiles: CustomerProfileService) {}

  /**
   * The canonical customer behind the id, with `resolvedFrom` set when the id was a merged record.
   * 404 `CUSTOMER_NOT_FOUND` for an unknown or malformed id. The answer is `Cache-Control: no-store`.
   */
  @Permission('customers.view')
  @Get(':id')
  async profile(
    @Param('id', customerIdPipe()) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerProfile> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.profiles.profile(id);
    } catch (error) {
      throw customersHttpError(error);
    }
  }
}
