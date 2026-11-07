import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  SkuMovementsQuery,
  StockListQuery,
  type SkuMovementsResponse,
  type SkuStockResponse,
  type StockListResponse,
} from '@ssdashboard/contracts';
import { catalogHttpError, notFoundId } from '../../catalog/catalog.controller.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { ledgerHttpError } from '../ledger-http.js';
import { StockService } from './stock.service.js';

/**
 * Stock on hand (spec 0006), every route `stock.view` (spec 0008 route mapping). Inventory owns
 * these `/skus` paths because they read the ledger.
 */
@Audience('staff')
@Permission('stock.view')
@Controller()
export class StockController {
  /** Takes the stock service. */
  constructor(private readonly stock: StockService) {}

  /** One keyset page of stock on hand across locations; cost and value fields need `cost.view`. */
  @Get('stock')
  async list(
    @Query(new ZodQueryPipe(StockListQuery)) query: StockListQuery,
    @CurrentAccess() access: Access,
  ): Promise<StockListResponse> {
    try {
      return await this.stock.list(query, access);
    } catch (error) {
      throw ledgerHttpError(error);
    }
  }

  /** One SKU's stock per location; cost and value fields need `cost.view`. */
  @Get('skus/:id/stock')
  async forSku(
    @Param('id', notFoundId()) id: string,
    @CurrentAccess() access: Access,
  ): Promise<SkuStockResponse> {
    try {
      return await this.stock.forSku(id, access);
    } catch (error) {
      throw ledgerHttpError(catalogHttpError(error));
    }
  }

  /** Newest first, 50 a page with load more (AC-10); cost fields need `cost.view` (AC-11). */
  @Get('skus/:id/movements')
  async movements(
    @Param('id', notFoundId()) id: string,
    @Query(new ZodQueryPipe(SkuMovementsQuery)) query: SkuMovementsQuery,
    @CurrentAccess() access: Access,
  ): Promise<SkuMovementsResponse> {
    try {
      return await this.stock.movements(id, query, access);
    } catch (error) {
      throw ledgerHttpError(catalogHttpError(error));
    }
  }
}
