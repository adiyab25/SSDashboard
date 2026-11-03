import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { LocationListQuery, type LocationListResponse } from '@ssdashboard/contracts';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { InvalidCursorError, LocationsService } from './locations.service.js';

/**
 * Read only list for the shell's location switcher. Open until feature 6 adds the
 * session guard to every `/api` route except config, health, and auth.
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
}
