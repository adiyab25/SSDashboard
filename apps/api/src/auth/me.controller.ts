import { Controller, Get, Req } from '@nestjs/common';
import type { MeResponse } from '@ssdashboard/contracts';
import type { AuthenticatedRequest } from './current-staff.js';

@Controller('me')
export class MeController {
  /** Who is signed in. The web shell calls this to check the session and fill the user menu. */
  @Get()
  read(@Req() request: AuthenticatedRequest): MeResponse {
    const { sessionId: _sessionId, ...me } = request.staff;
    return me;
  }
}
