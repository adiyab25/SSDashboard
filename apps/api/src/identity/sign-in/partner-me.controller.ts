import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { UpdateMeRequest, type MeResponse } from '@ssdashboard/contracts';
import type { Access } from '../../platform/access/access.js';
import { CurrentAccess } from '../../platform/access/current-access.decorator.js';
import { AnyHat } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import type { CurrentPartner, PartnerRequest } from './current-staff.js';
import { ProfileService } from './profile.service.js';
import { WhoAmI } from './who-am-i.decorator.js';

/**
 * The partner "who am I" answer, the same `MeResponse` as `GET /api/me` (spec 0008, AC-11): the
 * person the guard read, their hats and permissions from this request's `Access`, and the partner
 * account the guard took from their own hat row. A partner user has no staff code.
 */
function partnerMeOf(partner: CurrentPartner, access: Access): MeResponse {
  return {
    id: partner.userId,
    name: partner.name,
    email: partner.email,
    hats: [...access.hats],
    permissions: [...access.permissions],
    partnerAccountId: partner.partnerAccountId,
    phone: partner.phone,
    staffCode: null,
    language: partner.language,
    twoFactorEnabled: partner.twoFactorEnabled,
    mustChangePassword: partner.mustChangePassword,
    home: partner.home,
  };
}

/**
 * A partner user's own profile routes under `/api/partner/me` (spec 0005 AC-28, spec 0008 AC-11),
 * open to any person whose hat allows the partner audience (`@AnyHat()`). Staff get 403
 * `WRONG_AUDIENCE` here and read `GET /api/me`.
 *
 * No handler here reads a partner account from the request (spec 0008, AC-9): the account is the
 * one on `request.partner`, which the guard read from the person's hat row.
 */
@Audience('partner')
@AnyHat()
@Controller('partner/me')
export class PartnerMeController {
  /** Takes the profile service that saves the person's own details. */
  constructor(private readonly profile: ProfileService) {}

  /**
   * Who is signed in, with `home` (`partner`), the hats and permissions, and the bound
   * `partnerAccountId`. The partner "who am I" handler (`@WhoAmI()`): the one partner route a
   * temporary password still reaches.
   */
  @WhoAmI()
  @Get()
  read(@Req() request: PartnerRequest, @CurrentAccess() access: Access): MeResponse {
    return partnerMeOf(request.partner, access);
  }

  /**
   * Change your own name, phone or language, as on `PATCH /api/me` (spec 0005, AC-19). The body
   * is strict: email, hats and the partner account are a manager's to change.
   */
  @Patch()
  async update(
    @Body(new ZodBodyPipe(UpdateMeRequest)) body: UpdateMeRequest,
    @Req() request: PartnerRequest,
    @CurrentAccess() access: Access,
  ): Promise<MeResponse> {
    await this.profile.update(request.partner.userId, body);
    return {
      ...partnerMeOf(request.partner, access),
      ...(body.name !== undefined && { name: body.name }),
      ...(body.phone !== undefined && { phone: body.phone }),
      ...(body.language !== undefined && { language: body.language }),
    };
  }
}
