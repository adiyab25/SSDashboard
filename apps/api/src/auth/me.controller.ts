import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { UpdateMeRequest, type MeResponse } from '@ssdashboard/contracts';
import { Audience } from '../platform/audience/audience.decorator.js';
import { ZodBodyPipe } from '../platform/zod-body.pipe.js';
import type { AuthenticatedRequest } from './current-staff.js';
import { ProfileService } from './profile.service.js';

@Audience('staff')
@Controller('me')
export class MeController {
  constructor(private readonly profile: ProfileService) {}

  /** Who is signed in. The web shell calls this to check the session and fill the user menu. */
  @Get()
  read(@Req() request: AuthenticatedRequest): MeResponse {
    const { sessionId: _sessionId, ...me } = request.staff;
    return me;
  }

  /**
   * Change your own name, phone or language (AC-19). The body is strict: email, role and staff
   * code are an admin's to change, so naming them here is refused, not ignored.
   */
  @Patch()
  async update(
    @Body(new ZodBodyPipe(UpdateMeRequest)) body: UpdateMeRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<MeResponse> {
    await this.profile.update(request.staff.id, body);
    const { sessionId: _sessionId, ...me } = request.staff;
    return {
      ...me,
      ...(body.name !== undefined && { name: body.name }),
      ...(body.phone !== undefined && { phone: body.phone }),
      ...(body.language !== undefined && { language: body.language }),
    };
  }
}
