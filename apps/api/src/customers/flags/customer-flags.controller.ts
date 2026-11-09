import { Body, Controller, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  CustomerClearFlagRequest,
  CustomerSetFlagRequest,
  type CustomerSetFlagResponse,
} from '@ssdashboard/contracts';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { CustomerBodyPipe, customerIdPipe, customersHttpError } from '../customers-http.js';
import { CustomerFlags, type FlagActor } from './customer-flags.service.js';

/** The person acting, under the hat that holds `customers.flag`. */
const flagActor = (request: AuthenticatedRequest, access: Access): FlagActor => ({
  userId: request.staff.id,
  hat: access.actingHat('customers.flag'),
});

/**
 * The flag routes of spec 0014 (AC-11): `PUT /api/customers/:id/flag` sets a person's flag and
 * `POST /api/customers/:id/flag/clear` clears it, both `customers.flag`. Its controller is listed
 * before the `:id` profile one. Bodies are never echoed: the note is personal data.
 */
@Audience('staff')
@RequiresModule('customers')
@Controller('customers')
export class CustomerFlagsController {
  /** Takes the flag service. */
  constructor(private readonly flags: CustomerFlags) {}

  /**
   * Sets a `manual` flag (200 `{ flag, updatedAt }`). 404 `CUSTOMER_NOT_FOUND`; 409
   * `STALE_RECORD`, `CUSTOMER_MERGED`; 422 `REASON_INVALID`, `NOTE_TOO_LONG`, `VALIDATION_FAILED`.
   * The id is lower cased first, because Postgres answers ids in lower case.
   */
  @Permission('customers.flag')
  @Put(':id/flag')
  @HttpCode(200)
  async set(
    @Param('id', customerIdPipe()) id: string,
    @Body(new CustomerBodyPipe(CustomerSetFlagRequest)) body: CustomerSetFlagRequest,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<CustomerSetFlagResponse> {
    try {
      return await this.flags.set(
        id.toLowerCase(),
        {
          kind: body.kind,
          expectedUpdatedAt: body.expectedUpdatedAt,
          ...(body.note === undefined ? {} : { note: body.note }),
          ...(body.reasonCode === undefined ? {} : { reasonCode: body.reasonCode }),
        },
        flagActor(request, access),
      );
    } catch (error) {
      throw customersHttpError(error);
    }
  }

  /**
   * Clears the flag on every id of the canonical customer (204). 404 `CUSTOMER_NOT_FOUND`; 409
   * `STALE_RECORD`, `NOT_FLAGGED`; 422 `REASON_REQUIRED`, `REASON_INVALID`, `VALIDATION_FAILED`.
   */
  @Permission('customers.flag')
  @Post(':id/flag/clear')
  @HttpCode(204)
  async clear(
    @Param('id', customerIdPipe()) id: string,
    @Body(new CustomerBodyPipe(CustomerClearFlagRequest)) body: CustomerClearFlagRequest,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<void> {
    try {
      await this.flags.clear(id.toLowerCase(), body, flagActor(request, access));
    } catch (error) {
      throw customersHttpError(error);
    }
  }
}
