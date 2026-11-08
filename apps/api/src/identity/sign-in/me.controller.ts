import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { UpdateMeRequest, type MeResponse } from '@ssdashboard/contracts';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { AnyHat } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import type { AuthenticatedRequest, CurrentStaff } from './current-staff.js';
import { ProfileService } from './profile.service.js';
import { WhoAmI } from './who-am-i.decorator.js';
import { RequiresModule } from '../../platform/modules/requires-module.decorator.js';

/**
 * The "who am I" answer: the person the guard read, plus their hats, their effective permissions
 * (sorted) and their partner account, all from the `Access` the guard loaded on this request.
 */
function meOf(staff: CurrentStaff, access: Access): MeResponse {
  const { sessionId: _sessionId, ...person } = staff;
  return {
    ...person,
    hats: [...access.hats],
    permissions: [...access.permissions],
    partnerAccountId: access.partnerAccountId,
  };
}

/**
 * The signed in person's own profile routes under `/api/me`, open to any person with a staff hat
 * (`@AnyHat()`, spec 0008 route mapping).
 */
@Audience('staff')
@AnyHat()
@RequiresModule('identity')
@Controller('me')
export class MeController {
  /** Takes the profile service that saves the person's own details. */
  constructor(private readonly profile: ProfileService) {}

  /**
   * Who is signed in, with `home`, where the sign in page sends them (AC-28; `backoffice` for
   * staff), and `hats`, `permissions` and `partnerAccountId` (null here), which the web reads once
   * per page load to hide what the person cannot use (spec 0008, AC-11). A partner user gets 403
   * `WRONG_AUDIENCE` here and reads `GET /api/partner/me`. The staff "who am I" handler
   * (`@WhoAmI()`): the one route a temporary password still reaches.
   */
  @WhoAmI()
  @Get()
  read(@Req() request: AuthenticatedRequest, @CurrentAccess() access: Access): MeResponse {
    return meOf(request.staff, access);
  }

  /**
   * Change your own name, phone or language (AC-19). The body is strict: email, hats and staff
   * code are a manager's to change, so naming them here is refused, not ignored.
   */
  @Patch()
  async update(
    @Body(new ZodBodyPipe(UpdateMeRequest)) body: UpdateMeRequest,
    @Req() request: AuthenticatedRequest,
    @CurrentAccess() access: Access,
  ): Promise<MeResponse> {
    await this.profile.update(request.staff.id, body);
    return {
      ...meOf(request.staff, access),
      ...(body.name !== undefined && { name: body.name }),
      ...(body.phone !== undefined && { phone: body.phone }),
      ...(body.language !== undefined && { language: body.language }),
    };
  }
}
