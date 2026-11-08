import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateProductRequest,
  SkuListQuery,
  UpdateSkuRequest,
  type SkuDetail,
  type SkuListResponse,
} from '@ssdashboard/contracts';
import type { z } from 'zod';
import { Permission } from '../platform/access/permission.decorator.js';
import { Audience } from '../platform/audience/audience.decorator.js';
import { InvalidCursorError } from '../platform/keyset-cursor.js';
import { INVALID_INPUT, ZodBodyPipe } from '../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { CatalogError, CatalogService } from './catalog.service.js';
import { RequiresModule } from '../platform/modules/requires-module.decorator.js';

/** Maps catalog errors to the stable codes of spec 0006. */
export function catalogHttpError(error: unknown): unknown {
  if (error instanceof CatalogError) {
    switch (error.code) {
      case 'StyleCodeTaken':
        return new ConflictException({ code: 'STYLE_CODE_TAKEN', message: error.message });
      case 'SkuTaken':
        return new ConflictException({ code: 'SKU_TAKEN', message: error.message });
      case 'NotFound':
        return new NotFoundException({ code: 'NOT_FOUND', message: error.message });
      case 'Stale':
        return new ConflictException({ code: 'STALE_RECORD', message: error.message });
      case 'InUse':
        return new ConflictException({ code: 'IN_USE', message: error.message });
    }
  }
  if (error instanceof InvalidCursorError) {
    return new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
  }
  return error;
}

/** A malformed id is a SKU that does not exist: 404, never 400. Inventory's `/skus` routes reuse it. */
export const notFoundId = () =>
  new ParseUUIDPipe({
    exceptionFactory: () => new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' }),
  });

/**
 * Products in, SKUs out (spec 0006). Creating and editing name and price need `catalog.edit`,
 * reading needs `stock.view`, and delete needs `catalog.manage` (spec 0008 route mapping). Stock
 * dependent SKU actions live in inventory's `sku-lifecycle/`.
 */
@Audience('staff')
@RequiresModule('catalog')
@Controller()
export class CatalogController {
  /** Takes the catalog service that holds the rules. */
  constructor(private readonly catalog: CatalogService) {}

  /**
   * Creates one active product with one stocked SKU and returns that SKU. A taken SKU code is
   * mapped to an HTTP error by `catalogHttpError`.
   */
  @Permission('catalog.edit')
  @Post('products')
  async create(
    @Body(new ZodBodyPipe(CreateProductRequest, INVALID_INPUT))
    body: z.output<typeof CreateProductRequest>,
  ): Promise<SkuDetail> {
    try {
      return await this.catalog.createProduct(body);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** One keyset page of SKUs for the catalog list, filtered by the validated query. */
  @Permission('stock.view')
  @Get('skus')
  async list(@Query(new ZodQueryPipe(SkuListQuery)) query: SkuListQuery): Promise<SkuListResponse> {
    try {
      return await this.catalog.list(query);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** One SKU's detail; an unknown or malformed id answers 404. */
  @Permission('stock.view')
  @Get('skus/:id')
  async get(@Param('id', notFoundId()) id: string): Promise<SkuDetail> {
    try {
      return await this.catalog.getSku(id);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Name and price, with the stale check (AC-2). The code changes through inventory. */
  @Permission('catalog.edit')
  @Patch('skus/:id')
  async update(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(UpdateSkuRequest, INVALID_INPUT))
    body: z.output<typeof UpdateSkuRequest>,
  ): Promise<SkuDetail> {
    try {
      return await this.catalog.updateSku(id, body);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`, and only while nothing references the SKU (AC-3): 409 `IN_USE` otherwise. */
  @Permission('catalog.manage')
  @Delete('skus/:id')
  @HttpCode(204)
  async remove(@Param('id', notFoundId()) id: string): Promise<void> {
    try {
      await this.catalog.deleteSku(id);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }
}
