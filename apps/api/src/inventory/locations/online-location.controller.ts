import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import {
  ConfirmLocationStockRequest,
  MakeLocationOnlineRequest,
  StopOnlineRequest,
  type LocationDetail,
  type OnlineGateView,
  type StopOnlineResponse,
} from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';
import { INVALID_INPUT, ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { locationHttpError, locationId } from './locations.controller.js';
import { OnlineLocationService } from './online-location.service.js';

/**
 * The online gate routes (spec 0011 AC-19), every one `catalog.manage`: read the gate, confirm a
 * location's stock counted, make a location the online one, and stop online stock. Errors go
 * through `locationHttpError`; a missing or blank reason on a move or stop answers 422
 * `REASON_REQUIRED` (the audit writer's rule).
 */
@Audience('staff')
@RequiresModule('inventory')
@Controller('locations')
export class OnlineLocationController {
  /** Takes the online location service. */
  constructor(private readonly online: OnlineLocationService) {}

  /** Stops online stock: no location feeds it afterwards. 409 `NO_ONLINE_LOCATION` when none does. */
  @Permission('catalog.manage')
  @Post('online/stop')
  @HttpCode(200)
  async stop(
    @Body(new ZodBodyPipe(StopOnlineRequest, INVALID_INPUT))
    body: z.output<typeof StopOnlineRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StopOnlineResponse> {
    try {
      return await this.online.stop(body.reason, { id: request.staff.id, access });
    } catch (error) {
      throw locationHttpError(error, response);
    }
  }

  /** Whether the location may go online and what that will do: checks, counts, current location. */
  @Permission('catalog.manage')
  @Get(':id/online-gate')
  async gate(
    @Param('id', locationId()) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OnlineGateView> {
    try {
      return await this.online.gateFor(id);
    } catch (error) {
      throw locationHttpError(error, response);
    }
  }

  /** Confirms the location's stock counted. 409 `ALREADY_CONFIRMED` the second time. */
  @Permission('catalog.manage')
  @Post(':id/confirm-stock')
  @HttpCode(200)
  async confirmStock(
    @Param('id', locationId()) id: string,
    @Body(new ZodBodyPipe(ConfirmLocationStockRequest, INVALID_INPUT))
    body: z.output<typeof ConfirmLocationStockRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocationDetail> {
    try {
      return await this.online.confirmStock(id, body.reason, { id: request.staff.id, access });
    } catch (error) {
      throw locationHttpError(error, response);
    }
  }

  /**
   * Makes the location the online one, with the variant count the manager saw and a written
   * reason. 409 `ONLINE_GATE_FAILED` (with `failedKeys`) or `ONLINE_GATE_STALE`; 422
   * `ONLINE_NEEDS_WAREHOUSE`, `NOT_SELLABLE_ONLINE`, `REASON_REQUIRED`.
   */
  @Permission('catalog.manage')
  @Post(':id/make-online')
  @HttpCode(200)
  async makeOnline(
    @Param('id', locationId()) id: string,
    @Body(new ZodBodyPipe(MakeLocationOnlineRequest, INVALID_INPUT))
    body: z.output<typeof MakeLocationOnlineRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocationDetail> {
    try {
      return await this.online.makeOnline(id, body, { id: request.staff.id, access });
    } catch (error) {
      throw locationHttpError(error, response);
    }
  }
}
