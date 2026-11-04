import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateProductRequest,
  SkuListQuery,
  type SkuDetail,
  type SkuListResponse,
} from '@ssdashboard/contracts';
import type { z } from 'zod';
import { InvalidCursorError } from '../platform/keyset-cursor.js';
import { INVALID_INPUT, ZodBodyPipe } from '../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { CatalogError, CatalogService } from './catalog.service.js';

/** Maps catalog errors to the stable codes of spec 0006. */
export function catalogHttpError(error: unknown): unknown {
  if (error instanceof CatalogError) {
    switch (error.code) {
      case 'SkuTaken':
        return new ConflictException({ code: 'SKU_TAKEN', message: error.message });
      case 'NotFound':
        return new NotFoundException({ code: 'NOT_FOUND', message: error.message });
    }
  }
  if (error instanceof InvalidCursorError) {
    return new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
  }
  return error;
}

const notFoundId = () =>
  new ParseUUIDPipe({
    exceptionFactory: () => new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' }),
  });

/** Products in, SKUs out (spec 0006). Any signed in person; admin actions come in Milestone 3. */
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

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

  @Get('skus')
  async list(@Query(new ZodQueryPipe(SkuListQuery)) query: SkuListQuery): Promise<SkuListResponse> {
    try {
      return await this.catalog.list(query);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  @Get('skus/:id')
  async get(@Param('id', notFoundId()) id: string): Promise<SkuDetail> {
    try {
      return await this.catalog.getSku(id);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }
}
