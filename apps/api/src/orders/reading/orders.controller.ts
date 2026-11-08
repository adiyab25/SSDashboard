import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  CreateGiftedOrderBody,
  CreateManualOrderBody,
  GiftReasonCode,
  OrderListQuery,
  type CreatedOrder,
  type OrderDetail,
  type OrderFilterOptions,
  type OrderListResponse,
  type OrderOptions,
} from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { InvalidCursorError } from '../../platform/keyset-cursor.js';
import { ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { OrderIntake } from '../intake/order-intake.service.js';
import { OrderTransactions } from '../order-transactions.js';
import { orderIdPipe, ordersHttpError } from '../orders-http.js';
import { serializeOrderDetail } from './order-cost.js';
import { phoneOfSearch } from './order-list-sql.js';
import { OrderQueries } from './order-query.service.js';

/** The body pipe of the list search: 400 `INVALID_QUERY`, like the query string of the list. */
const searchBody = new ZodBodyPipe(OrderListQuery, { status: 400, code: 'INVALID_QUERY' });
/** The body pipe of the create routes: 422 `INVALID_BODY`. */
const INVALID_BODY = { status: 422, code: 'INVALID_BODY' } as const;

/**
 * The orders routes of milestone 1 (spec 0013 API surface), all `@Audience('staff')` with one
 * `@Permission` each: the list and search (`orders.view`), the order page (`orders.view`), the
 * form options and manual order (`orders.confirm`), and the gifted order (`orders.gift`). Every
 * answer is `Cache-Control: no-store` because it holds ship to fields. A write route opens one
 * `OrderTransactions.run` and maps the module's errors to stable codes. Logs carry the order id
 * and the person's id only, never a ship to field, a phone, or a typed search.
 */
@Audience('staff')
@Controller('orders')
export class OrdersController {
  private readonly logger = new Logger('Orders');

  /** Takes the transaction opener, the intake write path, and the read side. */
  constructor(
    private readonly transactions: OrderTransactions,
    private readonly intake: OrderIntake,
    private readonly queries: OrderQueries,
  ) {}

  /**
   * `GET /api/orders`: the filtered, keyset paged list. A `q` that parses as a phone is refused
   * with 400 `PHONE_IN_URL` (the web sends it as `POST /api/orders/search`) and never echoed.
   */
  @Permission('orders.view')
  @Get()
  async list(
    @Query(new ZodQueryPipe(OrderListQuery)) query: z.output<typeof OrderListQuery>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderListResponse> {
    response.setHeader('Cache-Control', 'no-store');
    if (query.q !== undefined && phoneOfSearch(query.q) !== null) {
      throw new BadRequestException({
        code: 'PHONE_IN_URL',
        message: 'A phone number is searched with POST /api/orders/search, never in the URL',
      });
    }
    return this.read(query);
  }

  /** `POST /api/orders/search`: the same list with the filters in the body, for a phone search. */
  @Permission('orders.view')
  @Post('search')
  @HttpCode(200)
  async search(
    @Body(searchBody) query: z.output<typeof OrderListQuery>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderListResponse> {
    response.setHeader('Cache-Control', 'no-store');
    return this.read(query);
  }

  /** `GET /api/orders/options`: what the new order form offers. Declared before `:id`. */
  @Permission('orders.confirm')
  @Get('options')
  options(@Res({ passthrough: true }) response: Response): Promise<OrderOptions> {
    response.setHeader('Cache-Control', 'no-store');
    return this.queries.options(GiftReasonCode.options);
  }

  /**
   * `GET /api/orders/filter-options`: every store and channel that is not archived, Shopify
   * ones included, for the list filters of any `orders.view` holder. Declared before `:id`.
   */
  @Permission('orders.view')
  @Get('filter-options')
  filterOptions(@Res({ passthrough: true }) response: Response): Promise<OrderFilterOptions> {
    response.setHeader('Cache-Control', 'no-store');
    return this.queries.filterOptions();
  }

  /** `GET /api/orders/:id`: the order page; 404 `ORDER_NOT_FOUND` for an unknown or malformed id. */
  @Permission('orders.view')
  @Get(':id')
  async detail(
    @Param('id', orderIdPipe()) id: string,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OrderDetail> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return serializeOrderDetail(await this.queries.detail(id), access);
    } catch (error) {
      throw ordersHttpError(error, response);
    }
  }

  /**
   * `POST /api/orders`: a manual sale (AC-1). 201 with the new order; 200 with the first order
   * when the same `clientRef` repeats.
   */
  @Permission('orders.confirm')
  @Post()
  async create(
    @Body(new ZodBodyPipe(CreateManualOrderBody, INVALID_BODY))
    body: z.output<typeof CreateManualOrderBody>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreatedOrder> {
    return this.createOrder(body, request, access, 'orders.confirm', response);
  }

  /** `POST /api/orders/gifted`: a gifted order (AC-2), only for a person with `orders.gift`. */
  @Permission('orders.gift')
  @Post('gifted')
  async createGifted(
    @Body(new ZodBodyPipe(CreateGiftedOrderBody, INVALID_BODY))
    body: z.output<typeof CreateGiftedOrderBody>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreatedOrder> {
    return this.createOrder(body, request, access, 'orders.gift', response);
  }

  private async read(query: z.output<typeof OrderListQuery>): Promise<OrderListResponse> {
    try {
      return await this.queries.list(query);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new BadRequestException({ code: 'INVALID_CURSOR', message: error.message });
      }
      throw error;
    }
  }

  private async createOrder(
    body: z.output<typeof CreateManualOrderBody> | z.output<typeof CreateGiftedOrderBody>,
    request: AuthenticatedRequest,
    access: Access,
    permission: 'orders.confirm' | 'orders.gift',
    response: Response,
  ): Promise<CreatedOrder> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const person = {
        type: 'person',
        userId: request.staff.id,
        hat: access.actingHat(permission),
      } as const;
      const options = { mayGift: access.has('orders.gift') };
      const made = await this.transactions.run((tx) =>
        this.intake.createManual(tx, body, person, options),
      );
      response.status(made.created ? 201 : 200);
      this.logger.log(
        `order ${made.created ? 'created' : 'repeated'} order=${made.id} person=${request.staff.id}`,
      );
      return { id: made.id, storeCode: made.storeCode, orderNumber: made.orderNumber };
    } catch (error) {
      throw ordersHttpError(error, response);
    }
  }
}
