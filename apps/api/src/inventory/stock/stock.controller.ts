import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import {
  StockListQuery,
  type SkuStockResponse,
  type StockListResponse,
} from '@ssdashboard/contracts';
import type { AuthenticatedRequest } from '../../auth/current-staff.js';
import { catalogHttpError } from '../../catalog/catalog.controller.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { ledgerHttpError } from '../ledger-http.js';
import { StockService } from './stock.service.js';

/** Stock on hand (spec 0006). Inventory owns these `/skus` paths because they read the ledger. */
@Controller()
export class StockController {
  constructor(private readonly stock: StockService) {}

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

  @Get('skus/:id/stock')
  async forSku(
    @Param(
      'id',
      new ParseUUIDPipe({
        exceptionFactory: () => new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' }),
      }),
    )
    id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<SkuStockResponse> {
    try {
      return await this.stock.forSku(id, request.staff.role);
    } catch (error) {
      throw ledgerHttpError(catalogHttpError(error));
    }
  }
}
