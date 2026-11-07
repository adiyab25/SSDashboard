import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  AccessRequest,
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
import type { AuthenticatedRequest } from '../sign-in/current-staff.js';
import { actorOf } from '../access/actor.js';
import { InvalidAccountCursorError } from '../accounts/account-actions.js';
import { HatService } from '../hats/hat.service.js';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { StaffService } from './staff.service.js';

/**
 * Staff administration (spec 0005, AC-12 to AC-18). Every route needs `people.manage` (spec 0008
 * route mapping). The browser never talks to
 * Better Auth's admin routes: those answer 404, and these endpoints are the whole surface.
 */
@Audience('staff')
@Permission('people.manage')
@Controller('staff')
export class StaffController {
  /** Takes the staff service and the hat service, the one writer of hats and the cost grant. */
  constructor(
    private readonly staff: StaffService,
    private readonly hats: HatService,
  ) {}

  /**
   * One keyset page of staff, filtered by the validated query. A cursor this endpoint did not
   * issue answers 400 `INVALID_QUERY`.
   */
  @Get()
  async list(
    @Query(new ZodQueryPipe(StaffListQuery)) query: StaffListQuery,
  ): Promise<StaffListResponse> {
    try {
      return await this.staff.list(query);
    } catch (error) {
      if (error instanceof InvalidAccountCursorError) {
        throw new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
      }
      throw error;
    }
  }

  /**
   * Creates an account with its hats and cost switch (spec 0008, AC-14) and returns it with how
   * the person gets in: an emailed invite or a temporary password to hand over.
   */
  @Post()
  create(
    @Body(new ZodBodyPipe(CreateStaffRequest)) body: CreateStaffRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<CreateStaffResponse> {
    return this.staff.create(body, actorOf(request));
  }

  /** One staff account's detail. */
  @Get(':id')
  get(@Param('id') id: string): Promise<StaffDetail> {
    return this.staff.get(id);
  }

  /** Changes a person's details (never their hats or cost: `PUT :id/access`). */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodBodyPipe(UpdateStaffRequest)) body: UpdateStaffRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffDetail> {
    return this.staff.update(id, body, actorOf(request));
  }

  /**
   * Replaces a person's whole access set, hats and cost grant (spec 0008, AC-12), and returns
   * their detail with the new `updatedAt`. `HatService` decides every refusal: 409
   * `STALE_RECORD`, `SELF_HAT_CHANGE`, `LAST_ADMIN`; 422 `NO_HAT`, `HAT_CONFLICT`,
   * `GRANT_NOT_ALLOWED`, `REASON_REQUIRED`; 403 `FORBIDDEN` for a cost change by an actor without
   * `cost.view`; 404 for anyone who is not staff.
   */
  @Put(':id/access')
  async replaceAccess(
    @Param('id') id: string,
    @Body(new ZodBodyPipe(AccessRequest)) body: AccessRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffDetail> {
    await this.hats.replaceStaffAccess(id, body, actorOf(request));
    return this.staff.get(id);
  }

  /** Disables an account with an optional reason; ends its sessions and invalidates its links. */
  @Post(':id/disable')
  @HttpCode(200)
  disable(
    @Param('id') id: string,
    @Body(new ZodBodyPipe(DisableStaffRequest)) body: DisableStaffRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffDetail> {
    return this.staff.disable(id, body.reason, actorOf(request));
  }

  /** Re-enables a disabled account. */
  @Post(':id/enable')
  @HttpCode(200)
  enable(@Param('id') id: string, @Req() request: AuthenticatedRequest): Promise<StaffDetail> {
    return this.staff.enable(id, actorOf(request));
  }

  /**
   * Resets another person's password, by email or with a temporary password. Never one's own:
   * that answers 409 `SELF_ACTION`.
   */
  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ResetStaffPasswordResponse> {
    return this.staff.resetPassword(id, actorOf(request));
  }

  /**
   * Sends a new invite to an account that has never signed in. Refused when the install sends no
   * email.
   */
  @Post(':id/resend-invite')
  @HttpCode(200)
  resendInvite(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ ok: true }> {
    return this.staff.resendInvite(id, actorOf(request));
  }

  /** Turns off another person's two factor and ends their sessions. */
  @Post(':id/reset-two-factor')
  @HttpCode(200)
  resetTwoFactor(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<StaffDetail> {
    return this.staff.resetTwoFactor(id, actorOf(request));
  }

  /** Signs another person out everywhere. Never one's own: that answers 409 `SELF_ACTION`. */
  @Post(':id/revoke-sessions')
  @HttpCode(200)
  revokeSessions(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RevokeSessionsResponse> {
    return this.staff.revokeSessions(id, actorOf(request));
  }
}
