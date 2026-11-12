import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  CostRecordListQuery,
  RecordCostRequest,
  type CostRecordListResponse,
  type RecordCostResponse,
} from '@ssdashboard/contracts';
import type { z } from 'zod';
import { auditHttpError } from '../../audit/audit-http.js';
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
import { CostRecordsService } from './cost-records.service.js';

/**
 * A style's cost records (spec 0012, AC-13, AC-16): reading needs `stock.view` and `cost.view`,
 * adding one `catalog.edit` and `cost.view` (owner decision Q-12.5), both required. Staff only.
 * Records are only added; no route edits or deletes one. Holds no rule itself.
 */
@Audience('staff')
@RequiresModule('catalog')
@Controller('styles/:id/cost-records')
export class CostRecordsController {
  /** Takes the cost records service. */
  constructor(private readonly records: CostRecordsService) {}

  /**
   * One page of the style's records, newest recorded first (at most 50); 404 `NOT_FOUND` for an
   * unknown style, 400 `INVALID_QUERY` for a bad page size or cursor.
   */
  @Permission('stock.view', 'cost.view')
  @Get()
  async list(
    @Param('id', notFoundId()) id: string,
    @Query(new ZodQueryPipe(CostRecordListQuery)) query: CostRecordListQuery,
  ): Promise<CostRecordListResponse> {
    try {
      return await this.records.list(id, query);
    } catch (error) {
      throw catalogHttpError(error);
    }
  }

  /**
   * Adds a record to the style, or to one of its variants as an override (201). 422
   * `INVALID_INPUT` for a bad body, 422 `REASON_REQUIRED` for a record from before today's
   * operating day without a reason, 404 `NOT_FOUND` for an unknown style or season or a variant
   * outside the style. Answers the new record and the style's variant costs.
   */
  @Permission('catalog.edit', 'cost.view')
  @Post()
  @HttpCode(201)
  async record(
    @Param('id', notFoundId()) id: string,
    @Body(new ZodBodyPipe(RecordCostRequest, UNPROCESSABLE_INPUT))
    body: z.output<typeof RecordCostRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<RecordCostResponse> {
    try {
      return await this.records.record(id, body, catalogCallerOf(request, access));
    } catch (error) {
      throw auditHttpError(error) ?? catalogHttpError(error);
    }
  }
}
