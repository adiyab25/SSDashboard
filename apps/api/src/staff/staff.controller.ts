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
  CreateStaffRequest,
  DisableStaffRequest,
  StaffListQuery,
  UpdateStaffRequest,
  type CreateStaffResponse,
  type ResetStaffPasswordResponse,
  type RevokeSessionsResponse,
  type StaffDetail,
  type StaffListResponse,
} from '@ssdashboard/contracts';
import type { AuthenticatedRequest } from '../auth/current-staff.js';
import { clientIp, userAgent } from '../auth/client-info.js';
import { Roles } from '../auth/roles.decorator.js';
import { ZodBodyPipe } from '../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../platform/zod-query.pipe.js';
import { InvalidStaffCursorError, StaffService, type Actor } from './staff.service.js';

/** The headers of an Express request as a `Headers`, so the same address and agent readers apply. */
function actorOf(request: AuthenticatedRequest): Actor {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
  }
  return { id: request.staff.id, ip: clientIp(headers), userAgent: userAgent(headers) };
}

/**
 * Staff administration (spec 0005, AC-12 to AC-18). Admins only. The browser never talks to
 * Better Auth's admin routes: those answer 404, and these endpoints are the whole surface.
 */
@Roles('admin')
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  async list(
    @Query(new ZodQueryPipe(StaffListQuery)) query: StaffListQuery,
  ): Promise<StaffListResponse> {
    try {
      return await this.staff.list(query);
    } catch (error) {
      if (error instanceof InvalidStaffCursorError) {
        throw new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
      }
      throw error;
    }
  }

  @Post()
  create(
    @Body(new ZodBodyPipe(CreateStaffRequest)) body: CreateStaffRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<CreateStaffResponse> {
    return this.staff.create(body, actorOf(request));
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<StaffDetail> {
    return this.staff.get(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodBodyPipe(UpdateStaffRequest)) body: UpdateStaffRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffDetail> {
    return this.staff.update(id, body, actorOf(request));
  }

  @Post(':id/disable')
  @HttpCode(200)
  disable(
    @Param('id') id: string,
    @Body(new ZodBodyPipe(DisableStaffRequest)) body: DisableStaffRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffDetail> {
    return this.staff.disable(id, body.reason, actorOf(request));
  }

  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id') id: string, @Req() request: AuthenticatedRequest): Promise<StaffDetail> {
    return this.staff.enable(id, actorOf(request));
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ResetStaffPasswordResponse> {
    return this.staff.resetPassword(id, actorOf(request));
  }

  @Post(':id/resend-invite')
  @HttpCode(200)
  resendInvite(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ ok: true }> {
    return this.staff.resendInvite(id, actorOf(request));
  }

  @Post(':id/revoke-sessions')
  @HttpCode(200)
  revokeSessions(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RevokeSessionsResponse> {
    return this.staff.revokeSessions(id, actorOf(request));
  }
}
