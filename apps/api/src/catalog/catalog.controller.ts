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
  UnprocessableEntityException,
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
import { INVALID_INPUT, ZodBodyPipe, type ZodBodyPipeOptions } from '../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { CatalogError, CatalogService } from './catalog.service.js';
import { RequiresModule } from '../platform/modules/requires-module.decorator.js';

/** Maps catalog errors to the stable codes of specs 0006 and 0012. */
export function catalogHttpError(error: unknown): unknown {
  if (error instanceof CatalogError) {
    switch (error.code) {
      case 'StyleCodeTaken':
        return new ConflictException({ code: 'STYLE_CODE_TAKEN', message: error.message });
      case 'SkuTaken':
        return new ConflictException({ code: 'SKU_TAKEN', message: error.message });
      case 'NotFound':
        return new NotFoundException({
          code: 'NOT_FOUND',
          message: error.message,
          ...(error.details.missingIds ? { missingIds: error.details.missingIds } : {}),
        });
      case 'Stale':
        return new ConflictException({ code: 'STALE_RECORD', message: error.message });
      case 'InUse':
        return new ConflictException({ code: 'IN_USE', message: error.message });
      case 'Archived':
        return new UnprocessableEntityException({ code: 'ARCHIVED', message: error.message });
      case 'InvalidInput':
        return new UnprocessableEntityException({ code: 'INVALID_INPUT', message: error.message });
      case 'SeasonCodeTaken':
        return new ConflictException({ code: 'SEASON_CODE_TAKEN', message: error.message });
      case 'SeasonProtected':
        return new ConflictException({ code: 'SEASON_PROTECTED', message: error.message });
      case 'ProductGroupCodeTaken':
        return new ConflictException({ code: 'PRODUCT_GROUP_CODE_TAKEN', message: error.message });
      case 'ProductGroupProtected':
        return new ConflictException({ code: 'PRODUCT_GROUP_PROTECTED', message: error.message });
      case 'TooManyOptions':
        return new UnprocessableEntityException({
          code: 'TOO_MANY_OPTIONS',
          message: error.message,
        });
      case 'OptionCombinationTaken':
        return new ConflictException({ code: 'OPTION_COMBINATION_TAKEN', message: error.message });
      case 'BarcodeTaken':
        return new ConflictException({
          code: 'BARCODE_TAKEN',
          message: error.message,
          ...error.details,
        });
      case 'ReasonRequired':
        return new UnprocessableEntityException({
          code: 'REASON_REQUIRED',
          message: error.message,
        });
    }
  }
  if (error instanceof InvalidCursorError) {
    return new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
  }
  return error;
}

/**
 * The bad body answer spec 0012 names for seasons, product groups, and the bulk assign: 422
 * `INVALID_INPUT` (the spec 0006 routes keep 400).
 */
export const UNPROCESSABLE_INPUT: ZodBodyPipeOptions = { status: 422, code: 'INVALID_INPUT' };

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
