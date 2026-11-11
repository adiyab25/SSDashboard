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
  CreateSeasonRequest,
  GroupingListQuery,
  UpdateSeasonRequest,
  type Season,
  type SeasonListResponse,
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
import { SeasonsService } from './seasons.service.js';

/**
 * Seasons (spec 0012, AC-6, AC-16): reading needs `stock.view`, every write `catalog.manage`.
 * A bad body answers 422 `INVALID_INPUT`.
 */
@Audience('staff')
@RequiresModule('catalog')
@Controller('seasons')
export class SeasonsController {
  /** Takes the seasons service. */
  constructor(private readonly seasons: SeasonsService) {}

  /** One page of seasons, active ones by default. */
  @Permission('stock.view')
  @Get()
  async list(
    @Query(new ZodQueryPipe(GroupingListQuery)) query: GroupingListQuery,
  ): Promise<SeasonListResponse> {
    try {
      return await this.seasons.list(query);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: adds a season (409 `SEASON_CODE_TAKEN`). */
  @Permission('catalog.manage')
  @Post()
  async create(
    @Body(new ZodBodyPipe(CreateSeasonRequest, UNPROCESSABLE_INPUT))
    body: z.output<typeof CreateSeasonRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<Season> {
    try {
      return await this.seasons.create(body, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: edits a season with the stale check. */
  @Permission('catalog.manage')
  @Patch(':id')
  async update(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(UpdateSeasonRequest, UNPROCESSABLE_INPUT))
    body: z.output<typeof UpdateSeasonRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<Season> {
    try {
      return await this.seasons.update(id, body, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: archives a season (409 `SEASON_PROTECTED` for `CORE`). */
  @Permission('catalog.manage')
  @Post(':id/archive')
  @HttpCode(200)
  async archive(
    @Param('id', notFoundId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<Season> {
    try {
      return await this.seasons.setArchived(id, true, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: brings an archived season back to the pickers. */
  @Permission('catalog.manage')
  @Post(':id/unarchive')
  @HttpCode(200)
  async unarchive(
    @Param('id', notFoundId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<Season> {
    try {
      return await this.seasons.setArchived(id, false, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /** Needs `catalog.manage`: deletes a season nothing references (409 `IN_USE` otherwise). */
  @Permission('catalog.manage')
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id', notFoundId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<void> {
    try {
      await this.seasons.remove(id, catalogCallerOf(request, access));
    } catch (error) {
      throw catalogHttpError(error);
    }
  }
}
