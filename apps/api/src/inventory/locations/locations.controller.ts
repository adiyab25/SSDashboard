import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import {
  CreateLocationRequest,
  LocationListQuery,
  type LocationDetail,
  type LocationListResponse,
} from '@ssdashboard/contracts';
import type { z } from 'zod';
import { Roles } from '../../auth/roles.decorator.js';
import { INVALID_INPUT, ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import {
  InvalidCursorError,
  LocationCodeTakenError,
  LocationsService,
} from './locations.service.js';

/**
 * The shell's location switcher list, and location management for admins (spec 0006, AC-4).
 * Behind the session guard like every `/api` route except config, health, and auth.
 */
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  async list(
    @Query(new ZodQueryPipe(LocationListQuery)) query: LocationListQuery,
  ): Promise<LocationListResponse> {
    try {
      return await this.locations.listWorkLocations(query);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
      }
      throw error;
    }
  }

  @Roles('admin')
  @Post()
  async create(
    @Body(new ZodBodyPipe(CreateLocationRequest, INVALID_INPUT))
    body: z.output<typeof CreateLocationRequest>,
  ): Promise<LocationDetail> {
    try {
      return await this.locations.create(body);
    } catch (error) {
      if (error instanceof LocationCodeTakenError) {
        throw new ConflictException({ code: 'LOCATION_CODE_TAKEN', message: error.message });
      }
      throw error;
    }
  }
}
