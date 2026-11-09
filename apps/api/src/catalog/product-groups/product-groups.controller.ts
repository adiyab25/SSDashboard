import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  CreateProductGroupRequest,
  GroupingListQuery,
  UpdateProductGroupRequest,
  type ProductGroup,
  type ProductGroupListResponse,
} from '@ssdashboard/contracts';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { catalogCallerOf } from '../catalog-caller.js';
import { catalogHttpError, notFoundId, UNPROCESSABLE_INPUT } from '../catalog.controller.js';
import { ProductGroupsService } from './product-groups.service.js';

/**
 * Product groups (spec 0012, AC-7, AC-16): reading needs `stock.view`, every write `catalog.manage`.
 * A bad body answers 422 `INVALID_INPUT`.
 */
@Audience('staff')
@RequiresModule('catalog')
@Controller('product-groups')
export class ProductGroupsController {
  /** Takes the product groups service. */
  constructor(private readonly groups: ProductGroupsService) {}

  /** One page of product groups, active ones by default. */
  @Permission('stock.view')
  @Get()
  async list(
    @Query(new ZodQueryPipe(GroupingListQuery)) query: GroupingListQuery,
  ): Promise<ProductGroupListResponse> {
    try {
      return await this.groups.list(query);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: adds a product group (409 `PRODUCT_GROUP_CODE_TAKEN`). */
  @Permission('catalog.manage')
  @Post()
  async create(
    @Body(new ZodBodyPipe(CreateProductGroupRequest, UNPROCESSABLE_INPUT))
    body: z.output<typeof CreateProductGroupRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<ProductGroup> {
    try {
      return await this.groups.create(body, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: edits a product group with the stale check. */
  @Permission('catalog.manage')
  @Patch(':id')
  async update(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(UpdateProductGroupRequest, UNPROCESSABLE_INPUT))
    body: z.output<typeof UpdateProductGroupRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<ProductGroup> {
    try {
      return await this.groups.update(id, body, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: archives a product group (409 `PRODUCT_GROUP_PROTECTED` for `MAIN`). */
  @Permission('catalog.manage')
  @Post(':id/archive')
  @HttpCode(200)
  async archive(
    @Param('id', notFoundId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<ProductGroup> {
    try {
      return await this.groups.setArchived(id, true, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: brings an archived product group back to the pickers. */
  @Permission('catalog.manage')
  @Post(':id/unarchive')
  @HttpCode(200)
  async unarchive(
    @Param('id', notFoundId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<ProductGroup> {
    try {
      return await this.groups.setArchived(id, false, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: deletes a product group nothing references (409 `IN_USE` otherwise). */
  @Permission('catalog.manage')
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', notFoundId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<void> {
    try {
      await this.groups.remove(id, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }
}
