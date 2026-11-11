import { Body, Controller, Delete, HttpCode, Param, Post, Req } from '@nestjs/common';
import { AddBarcodeRequest, type SkuDetail } from '@ssdashboard/contracts';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { INVALID_INPUT, ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { catalogCallerOf } from '../catalog-caller.js';
import { catalogHttpError, notFoundId } from '../catalog.controller.js';
import { BarcodesService } from './barcodes.service.js';

/**
 * A SKU's barcodes (spec 0012, AC-10, AC-16), both `catalog.edit`. A bad code answers 400
 * `INVALID_INPUT`, a code another SKU holds 409 `BARCODE_TAKEN` with `skuCode`.
 */
@Audience('staff')
@RequiresModule('catalog')
@Controller('skus/:id/barcodes')
export class BarcodesController {
  /** Takes the barcodes service. */
  constructor(private readonly barcodes: BarcodesService) {}

  /** Needs `catalog.edit`: adds a barcode and returns the SKU with its barcodes. */
  @Permission('catalog.edit')
  @Post()
  async add(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(AddBarcodeRequest, INVALID_INPUT))
    body: z.output<typeof AddBarcodeRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<SkuDetail> {
    try {
      return await this.barcodes.add(id, body.code, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.edit`: removes one of the SKU's barcodes. */
  @Permission('catalog.edit')
  @Delete(':barcodeId')
  @HttpCode(204)
  async remove(
    @Param('id', notFoundId()) id: string,
    @Param('barcodeId', notFoundId()) barcodeId: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<void> {
    try {
      await this.barcodes.remove(id, barcodeId, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }
}
