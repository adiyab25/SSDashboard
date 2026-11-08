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
  Req,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CreateLocationRequest,
  LocationListQuery,
  UpdateLocationRequest,
  type LocationDetail,
  type LocationListResponse,
} from '@ssdashboard/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import type { AuthenticatedRequest } from '../../identity/sign-in/current-staff.js';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { forbidden } from '../../platform/access/permission.guard.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { INVALID_INPUT, ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { ledgerHttpError } from '../ledger-http.js';
import { LocationPolicyError } from './location-policy.service.js';
import {
  InvalidCursorError,
  LocationError,
  LocationsService,
  type LocationCaller,
} from './locations.service.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';

/** The signed in person and their `Access`, as the location service records the actor. */
const callerOf = (request: AuthenticatedRequest, access: Access): LocationCaller => ({
  id: request.staff.id,
  access,
});

/** Maps location errors to the stable codes of spec 0006; ledger errors go through `ledger-http`. */
export function locationHttpError(error: unknown, response?: Response): unknown {
  if (error instanceof LocationError) {
    switch (error.code) {
      case 'NotFound':
        return new NotFoundException({ code: 'NOT_FOUND', message: error.message });
      case 'CodeTaken':
        return new ConflictException({ code: 'LOCATION_CODE_TAKEN', message: error.message });
      case 'Stale':
        return new ConflictException({ code: 'STALE_RECORD', message: error.message });
      case 'CodeLocked':
        return new ConflictException({ code: 'CODE_LOCKED', message: error.message });
      case 'StockOnHand':
        return new ConflictException({ code: 'STOCK_ON_HAND', message: error.message });
      case 'InUse':
        return new ConflictException({ code: 'IN_USE', message: error.message });
    }
  }
  if (error instanceof LocationPolicyError) {
    switch (error.code) {
      case 'NotFound':
        return new NotFoundException({ code: 'NOT_FOUND', message: error.message });
      case 'NotSellableOnline':
        return new UnprocessableEntityException({
          code: 'NOT_SELLABLE_ONLINE',
          message: error.message,
        });
      case 'PartyRoleMismatch':
        return new UnprocessableEntityException({
          code: 'PARTY_ROLE_MISMATCH',
          message: error.message,
        });
    }
  }
  if (error instanceof InvalidCursorError) {
    return new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
  }
  return ledgerHttpError(error, response);
}

/** A malformed id is a location that does not exist: 404, never 400. */
const locationId = () =>
  new ParseUUIDPipe({
    exceptionFactory: () => new NotFoundException({ code: 'NOT_FOUND', message: 'Not found' }),
  });

/**
 * The shell's location switcher list (`stock.view`), and location management (`catalog.manage`;
 * spec 0006 AC-4, spec 0008 route mapping).
 * Behind the session guard like every `/api` route except config, health, and auth. The seeded
 * transit and virtual locations never appear and answer 404 here.
 */
@Audience('staff')
@RequiresModule('inventory')
@Controller('locations')
export class LocationsController {
  /** Takes the locations service. */
  constructor(private readonly locations: LocationsService) {}

  /**
   * Active locations with `stock.view`; `status=archived` also needs `catalog.manage`, checked
   * here through the caller's `Access` (403 `FORBIDDEN` without it).
   */
  @Permission('stock.view')
  @Get()
  async list(
    @Query(new ZodQueryPipe(LocationListQuery)) query: LocationListQuery,
    @CurrentAccess() access: Access,
  ): Promise<LocationListResponse> {
    if (query.status === 'archived' && !access.has('catalog.manage')) throw forbidden();
    try {
      return await this.locations.listWorkLocations(query);
    } catch (error) {
      throw locationHttpError(error);
    }
  }

  /**
   * Needs `catalog.manage`: adds a warehouse or shop. A code already in use is refused through
   * `locationHttpError`; a lock wait that times out answers 503 `BUSY` with `Retry-After`.
   */
  @Permission('catalog.manage')
  @Post()
  async create(
    @Body(new ZodBodyPipe(CreateLocationRequest, INVALID_INPUT))
    body: z.output<typeof CreateLocationRequest>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocationDetail> {
    try {
      return await this.locations.create(body);
    } catch (error) {
      throw locationHttpError(error, response);
    }
  }

  /**
   * Needs `catalog.manage`: edits a location's name or code, with the stale check so two people
   * cannot overwrite each other.
   */
  @Permission('catalog.manage')
  @Patch(':id')
  async update(
    @Param('id', locationId()) id: string,
    @Body(new ZodBodyPipe(UpdateLocationRequest, INVALID_INPUT))
    body: z.output<typeof UpdateLocationRequest>,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocationDetail> {
    try {
      return await this.locations.update(id, body, callerOf(request, access));
    } catch (error) {
      throw locationHttpError(error, response);
    }
  }

  /** Needs `catalog.manage`: archives a location, refused while stock is on hand or reserved there. */
  @Permission('catalog.manage')
  @Post(':id/archive')
  @HttpCode(200)
  async archive(
    @Param('id', locationId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocationDetail> {
    try {
      return await this.locations.archive(id, callerOf(request, access));
    } catch (error) {
      throw locationHttpError(error, response);
    }
  }

  /** Needs `catalog.manage`: brings an archived location back into the switcher. */
  @Permission('catalog.manage')
  @Post(':id/unarchive')
  @HttpCode(200)
  async unarchive(
    @Param('id', locationId()) id: string,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LocationDetail> {
    try {
      return await this.locations.unarchive(id, callerOf(request, access));
    } catch (error) {
      throw locationHttpError(error, response);
    }
  }

  /**
   * Needs `catalog.manage`: deletes a location nothing references yet; otherwise it must be archived
   * instead.
   */
  @Permission('catalog.manage')
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', locationId()) id: string): Promise<void> {
    try {
      await this.locations.delete(id);
    } catch (error) {
      throw locationHttpError(error);
    }
  }
}
