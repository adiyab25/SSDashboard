import { Body, Controller, Header, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import {
  CUSTOMER_PROFILE_GUARDED_FIELDS,
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
import { CustomerRiskSignals } from '../profile/customer-risk-signals.js';
import { CustomerFlags, type FlagActor, type SuggestionCheck } from './customer-flags.service.js';

/** The person acting, under the hat that holds `customers.flag`. */
const flagActor = (request: AuthenticatedRequest, access: Access): FlagActor => ({
  userId: request.staff.id,
  hat: access.actingHat('customers.flag'),
});

/**
 * The flag routes of spec 0014 (AC-11): `PUT /api/customers/:id/flag` sets a person's flag and
 * `POST /api/customers/:id/flag/clear` clears it, both `customers.flag`. They live in the leaf
 * `CustomerProfileModule` (milestone 4) because a set with reason code `suggestion_applied` (AC-13)
 * recomputes the returner signal from the orders module's counts. Bodies are never echoed: the
 * note is personal data.
 */
@Audience('staff')
@RequiresModule('customers')
@Controller('customers')
export class CustomerFlagsController {
  /** Takes the flag service and the returner signal. */
  constructor(
    private readonly flags: CustomerFlags,
    private readonly signals: CustomerRiskSignals,
  ) {}

  /**
   * Sets a `manual` flag (200 `{ flag, updatedAt }`). 404 `CUSTOMER_NOT_FOUND`; 409
   * `STALE_RECORD`, `CUSTOMER_MERGED`; 422 `REASON_INVALID`, `NOTE_TOO_LONG`, `VALIDATION_FAILED`.
   * Reason code `suggestion_applied` is accepted only while the customer has no flag and the
   * returner signal, recomputed under the locks, suggests exactly `kind` (else 422
   * `REASON_INVALID`) and the person holds `orders.view` (the signal reads order counts, AC-15;
   * else 422 `REASON_INVALID`); the entry then carries the counts in its `after`. The id is lower
   * cased first, because Postgres answers ids in lower case. The answer carries the note, so it
   * is `Cache-Control: no-store`.
   */
  @Permission('customers.flag')
  @Put(':id/flag')
  @Header('Cache-Control', 'no-store')
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
        // The signal reads order counts, which AC-15 puts behind `orders.view`: without it no
        // check is passed, so `suggestion_applied` is 422 `REASON_INVALID` and answers nothing.
        access.has(CUSTOMER_PROFILE_GUARDED_FIELDS.signal) ? this.suggestionCheck : undefined,
      );
    } catch (error) {
      throw customersHttpError(error);
    }
  }

  /** The returner signal of the customer's id set, read in the flag set's transaction. */
  private readonly suggestionCheck: SuggestionCheck = (tx, ids, flagged) =>
    this.signals.signalOf(ids, flagged, tx);

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
