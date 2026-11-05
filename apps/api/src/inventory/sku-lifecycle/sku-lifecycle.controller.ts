import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { ChangeSkuCodeRequest, type SkuDetail, type SkuUsage } from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import { Roles } from '../../auth/roles.decorator.js';
import { catalogHttpError, notFoundId } from '../../catalog/catalog.controller.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { INVALID_INPUT, ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ledgerHttpError } from '../ledger-http.js';
import { SkuLifecycleError, SkuLifecycleService } from './sku-lifecycle.service.js';

function lifecycleHttpError(error: unknown, response?: Response): unknown {
  if (error instanceof SkuLifecycleError) {
    switch (error.code) {
      case 'StockOnHand':
        return new ConflictException({ code: 'STOCK_ON_HAND', message: error.message });
      case 'CodeLocked':
        return new ConflictException({ code: 'CODE_LOCKED', message: error.message });
    }
  }
  return ledgerHttpError(catalogHttpError(error), response);
}

/** SKU actions that need stock state (spec 0006). Inventory owns these `/skus` paths. */
@Audience('staff')
@Controller('skus')
export class SkuLifecycleController {
  /** Takes the SKU lifecycle service. */
  constructor(private readonly lifecycle: SkuLifecycleService) {}

  /**
   * Tells the screen whether a SKU has stock history, so it can offer delete, archive or
   * neither.
   */
  @Get(':id/usage')
  async usage(@Param('id', notFoundId()) id: string): Promise<SkuUsage> {
    try {
      return await this.lifecycle.usage(id);
    } catch (error) {
      throw lifecycleHttpError(error);
    }
  }

  /**
   * Admin only: changes a SKU's code, which the lifecycle service refuses once stock has been
   * posted for it.
   */
  @Roles('admin')
  @Patch(':id/code')
  async changeCode(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(ChangeSkuCodeRequest, INVALID_INPUT))
    body: z.output<typeof ChangeSkuCodeRequest>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SkuDetail> {
    try {
      return await this.lifecycle.changeCode(id, body.sku, body.updatedAt);
    } catch (error) {
      throw lifecycleHttpError(error, response);
    }
  }

  /** Admin only: archives a SKU, refused while stock is on hand or reserved. */
  @Roles('admin')
  @Post(':id/archive')
  @HttpCode(200)
  async archive(
    @Param('id', notFoundId()) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SkuDetail> {
    try {
      return await this.lifecycle.archive(id);
    } catch (error) {
      throw lifecycleHttpError(error, response);
    }
  }

  /** Admin only: makes an archived SKU usable again. */
  @Roles('admin')
  @Post(':id/unarchive')
  @HttpCode(200)
  async unarchive(
    @Param('id', notFoundId()) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SkuDetail> {
    try {
      return await this.lifecycle.unarchive(id);
    } catch (error) {
      throw lifecycleHttpError(error, response);
    }
  }
}
