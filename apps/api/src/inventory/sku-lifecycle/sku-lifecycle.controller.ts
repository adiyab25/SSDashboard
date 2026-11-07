import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ChangeSkuCodeRequest, type SkuDetail, type SkuUsage } from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import { catalogHttpError, notFoundId } from '../../catalog/catalog.controller.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { INVALID_INPUT, ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ledgerHttpError } from '../ledger-http.js';
import { SkuLifecycleError, SkuLifecycleService, type SkuCaller } from './sku-lifecycle.service.js';

/** The signed in person and their `Access`, as the lifecycle service records the actor. */
const callerOf = (request: AuthenticatedRequest, access: Access): SkuCaller => ({
  id: request.staff.id,
  access,
});

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
  @Permission('stock.view')
  @Get(':id/usage')
  async usage(@Param('id', notFoundId()) id: string): Promise<SkuUsage> {
    try {
      return await this.lifecycle.usage(id);
    } catch (error) {
      throw lifecycleHttpError(error);
    }
  }

  /**
   * Needs `catalog.manage`: changes a SKU's code, which the lifecycle service refuses once stock has been
   * posted for it.
   */
  @Permission('catalog.manage')
  @Patch(':id/code')
  async changeCode(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(ChangeSkuCodeRequest, INVALID_INPUT))
    body: z.output<typeof ChangeSkuCodeRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SkuDetail> {
    try {
      return await this.lifecycle.changeCode(
        id,
        body.sku,
        body.updatedAt,
        callerOf(request, access),
      );
    } catch (error) {
      throw lifecycleHttpError(error, response);
    }
  }

  /** Needs `catalog.manage`: archives a SKU, refused while stock is on hand or reserved. */
  @Permission('catalog.manage')
  @Post(':id/archive')
  @HttpCode(200)
  async archive(
    @Param('id', notFoundId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SkuDetail> {
    try {
      return await this.lifecycle.archive(id, callerOf(request, access));
    } catch (error) {
      throw lifecycleHttpError(error, response);
    }
  }

  /** Needs `catalog.manage`: makes an archived SKU usable again. */
  @Permission('catalog.manage')
  @Post(':id/unarchive')
  @HttpCode(200)
  async unarchive(
    @Param('id', notFoundId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SkuDetail> {
    try {
      return await this.lifecycle.unarchive(id, callerOf(request, access));
    } catch (error) {
      throw lifecycleHttpError(error, response);
    }
  }
}
