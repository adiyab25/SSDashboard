import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import {
  SkuMovementsQuery,
  StockListQuery,
  type SkuMovementsResponse,
  type SkuStockResponse,
  type StockListResponse,
} from '@ssdashboard/contracts';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import { catalogHttpError, notFoundId } from '../../catalog/catalog.controller.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { ledgerHttpError } from '../ledger-http.js';
import { StockService } from './stock.service.js';

/** Stock on hand (spec 0006). Inventory owns these `/skus` paths because they read the ledger. */
@Audience('staff')
@Controller()
export class StockController {
  /** Takes the stock service. */
  constructor(private readonly stock: StockService) {}

  /** One keyset page of stock on hand across locations; cost and value fields only for admins. */
  @Get('stock')
  async list(
    @Query(new ZodQueryPipe(StockListQuery)) query: StockListQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<StockListResponse> {
    try {
      return await this.stock.list(query, request.staff.role);
    } catch (error) {
      throw ledgerHttpError(error);
    }
  }

  /** One SKU's stock per location; cost and value fields only for admins. */
  @Get('skus/:id/stock')
  async forSku(
    @Param('id', notFoundId()) id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<SkuStockResponse> {
    try {
      return await this.stock.forSku(id, request.staff.role);
    } catch (error) {
      throw ledgerHttpError(catalogHttpError(error));
    }
  }

  /** Newest first, 50 a page with load more (AC-10); cost fields for admins only (AC-11). */
  @Get('skus/:id/movements')
  async movements(
    @Param('id', notFoundId()) id: string,
    @Query(new ZodQueryPipe(SkuMovementsQuery)) query: SkuMovementsQuery,
    @Req() request: AuthenticatedRequest,
  ): Promise<SkuMovementsResponse> {
    try {
      return await this.stock.movements(id, query, request.staff.role);
    } catch (error) {
      throw ledgerHttpError(catalogHttpError(error));
    }
  }
}
