import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  CUSTOMER_SEARCH_RATE_LIMITED,
  CustomerSearchRequest,
  type CustomerSearchResponse,
} from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { customersHttpError } from '../customers-http.js';
import { CustomerSearchService } from './customer-search.service.js';
import { CustomerSearchThrottle } from './customer-search-throttle.js';

/** Which of the three searches a request is, for the log line. */
const modeOf = (body: z.output<typeof CustomerSearchRequest>): 'phone' | 'name' | 'flagged' =>
  body.phone !== undefined ? 'phone' : body.nameContains !== undefined ? 'name' : 'flagged';

/**
 * `POST /api/customers/search` (`customers.view`, spec 0014 AC-3, AC-5). A POST so a typed phone
 * or name never lands in a URL, a proxy log, or browser history; the api's Origin check covers it.
 * Each person may search {@link CustomerSearchThrottle} times a minute, and every search leaves one
 * log line with the person's id, the mode, the result count, and whether it was a later page:
 * never the typed phone or name.
 */
@Audience('staff')
@Controller('customers')
export class CustomerSearchController {
  private readonly logger = new Logger('CustomerSearch');

  /** Takes the search service and the per person throttle. */
  constructor(
    private readonly search: CustomerSearchService,
    private readonly throttle: CustomerSearchThrottle,
  ) {}

  /**
   * Finds customers by exactly one of `phone`, `nameContains`, or `flagged`. 400 `INVALID_QUERY`
   * for a body that is not exactly one of the three, 400 `INVALID_PHONE` (no echo) for phone
   * text that does not parse, 400 `INVALID_CURSOR` for a cursor it did not issue, 429
   * `SEARCH_RATE_LIMITED` (with `Retry-After`) past the per person limit. A search is not a
   * create, so it answers 200.
   */
  @Permission('customers.view')
  @Post('search')
  @HttpCode(200)
  async find(
    @Body(new ZodBodyPipe(CustomerSearchRequest, { status: 400, code: 'INVALID_QUERY' }))
    body: z.output<typeof CustomerSearchRequest>,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CustomerSearchResponse> {
    const personId = request.staff.id;
    // A list of names and phones: never kept by a browser or a shared cache.
    response.setHeader('Cache-Control', 'no-store');
    const turn = this.throttle.take(personId);
    if (!turn.allowed) {
      this.logger.warn(`search refused person=${personId} reason=rate_limited`);
      response.setHeader('Retry-After', String(turn.retryAfterSeconds));
      throw new HttpException(
        { code: CUSTOMER_SEARCH_RATE_LIMITED, message: 'Too many searches, wait a moment' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      const answer = await this.search.search(body);
      this.logger.log(
        `search person=${personId} mode=${modeOf(body)} results=${answer.items.length} paged=${body.cursor !== undefined}`,
      );
      return answer;
    } catch (error) {
      throw customersHttpError(error);
    }
  }
}
