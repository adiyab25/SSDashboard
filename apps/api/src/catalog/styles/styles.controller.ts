import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  AddVariantRequest,
  AssignStylesRequest,
  ChangeStyleCodeRequest,
  StyleListQuery,
  UpdateStyleRequest,
  type AssignStylesResponse,
  type SkuDetail,
  type StyleDetail,
  type StyleListResponse,
} from '@ssdashboard/contracts';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { INVALID_INPUT, ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { catalogCallerOf } from '../catalog-caller.js';
import { CatalogError } from '../catalog.service.js';
import { catalogHttpError, notFoundId, UNPROCESSABLE_INPUT } from '../catalog.controller.js';
import { serializeStyleDetail, StylesService } from './styles.service.js';

/**
 * Styles (spec 0012, AC-8 to AC-10, AC-16): reading needs `stock.view`; edits, the bulk assign,
 * and adding variants `catalog.edit`; the code change `catalog.manage`. `assign` is declared
 * before `:id` so the path is never read as an id. Every `StyleDetail` answer passes through
 * `serializeStyleDetail`, so only a caller holding `cost.view` sees a variant's `cost`.
 */
@Audience('staff')
@RequiresModule('catalog')
@Controller('styles')
export class StylesController {
  /** Takes the styles service. */
  constructor(private readonly styles: StylesService) {}

  /** One page of styles, filtered by the validated query. */
  @Permission('stock.view')
  @Get()
  async list(
    @Query(new ZodQueryPipe(StyleListQuery)) query: StyleListQuery,
  ): Promise<StyleListResponse> {
    try {
      return await this.styles.list(query);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /**
   * Needs `catalog.edit`: a season, a group, or both for 1 to 200 styles, all or nothing (404
   * `NOT_FOUND` with `missingIds`, 422 `ARCHIVED`, 422 `INVALID_INPUT`).
   */
  @Permission('catalog.edit')
  @Post('assign')
  @HttpCode(200)
  async assign(
    @Body(new ZodBodyPipe(AssignStylesRequest, UNPROCESSABLE_INPUT))
    body: z.output<typeof AssignStylesRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<AssignStylesResponse> {
    try {
      return await this.styles.assign(body, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /**
   * One style with its options and variants; an unknown or malformed id answers 404. Each
   * variant carries its `cost` in force today only for a caller holding `cost.view`.
   */
  @Permission('stock.view')
  @Get(':id')
  async get(
    @Param('id', notFoundId()) id: string,
    @CurrentAccess() access: Access,
  ): Promise<StyleDetail> {
    try {
      return serializeStyleDetail(await this.styles.get(id, access.has('cost.view')), access);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.edit`: name, description, season, group, and tags, with the stale check. */
  @Permission('catalog.edit')
  @Patch(':id')
  async update(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(UpdateStyleRequest, INVALID_INPUT))
    body: z.output<typeof UpdateStyleRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<StyleDetail> {
    try {
      return serializeStyleDetail(
        await this.styles.update(
          id,
          body,
          catalogCallerOf(request, access),
          access.has('cost.view'),
        ),
        access,
      );
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: a new style code (409 `STYLE_CODE_TAKEN`), with the stale check. */
  @Permission('catalog.manage')
  @Patch(':id/code')
  async changeCode(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(ChangeStyleCodeRequest, INVALID_INPUT))
    body: z.output<typeof ChangeStyleCodeRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<StyleDetail> {
    try {
      return serializeStyleDetail(
        await this.styles.changeCode(
          id,
          body,
          catalogCallerOf(request, access),
          access.has('cost.view'),
        ),
        access,
      );
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /**
   * Needs `catalog.edit`: adds a variant to the style and returns the new SKU. A bad body, an
   * option given twice, or a text that normalizes to nothing all answer 400 `INVALID_INPUT`: one
   * status per route (review M2 nit 2).
   */
  @Permission('catalog.edit')
  @Post(':id/variants')
  async addVariant(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(AddVariantRequest, INVALID_INPUT))
    body: z.output<typeof AddVariantRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<SkuDetail> {
    try {
      return await this.styles.addVariant(id, body, catalogCallerOf(request, access));
    } catch (error) {
      if (error instanceof CatalogError && error.code === 'InvalidInput') {
        throw new BadRequestException({ code: 'INVALID_INPUT', message: error.message });
      }
      throw catalogHttpError(error);
    }
  }
}
