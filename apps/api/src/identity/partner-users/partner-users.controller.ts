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
  CreatePartnerUserRequest,
  DisableStaffRequest,
  PartnerAccessRequest,
  PartnerUserListQuery,
  UpdatePartnerUserRequest,
  type CreatePartnerUserResponse,
  type PartnerAccountsResponse,
  type PartnerUserDetail,
  type PartnerUserListResponse,
  type ResetStaffPasswordResponse,
  type RevokeSessionsResponse,
} from '@ssdashboard/contracts';
import { Permission } from '../../platform/access/permission.decorator.js';
import { Audience } from '../../platform/audience/audience.decorator.js';
import { ZodBodyPipe } from '../../platform/zod-body.pipe.js';
import { ZodQueryPipe } from '../../platform/zod-query.pipe.js';
import { actorOf } from '../access/actor.js';
import { InvalidAccountCursorError } from '../accounts/account-actions.js';
import type { AuthenticatedRequest } from '../sign-in/current-staff.js';
import { PartnerUserService } from './partner-user.service.js';

/**
 * The partner logins a manager runs (spec 0008, AC-15): staff audience, every route
 * `people.manage`, the twins of `/api/staff`. A partner user is never reached through
 * `/api/staff`, and a staff id answers 404 here. The partner account a login is bound to changes
 * only through `PUT :id/access`; the partner account list comes from the partners module.
 */
@Audience('staff')
@Permission('people.manage')
@Controller('partner-users')
export class PartnerUsersController {
  /** Takes the partner user service. */
  constructor(private readonly partnerUsers: PartnerUserService) {}

  /**
   * One keyset page of partner logins, filtered by the validated query (a partner account, a
   * search, a status). A cursor this endpoint did not issue answers 400 `INVALID_QUERY`.
   */
  @Get()
  async list(
    @Query(new ZodQueryPipe(PartnerUserListQuery)) query: PartnerUserListQuery,
  ): Promise<PartnerUserListResponse> {
    try {
      return await this.partnerUsers.list(query);
    } catch (error) {
      if (error instanceof InvalidAccountCursorError) {
        throw new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
      }
      throw error;
    }
  }

  /**
   * The consignment partners a login can be bound to, `{ id, code, name }` by code. Declared
   * before `:id` so the path is never read as an id.
   */
  @Get('partner-accounts')
  partnerAccounts(): Promise<PartnerAccountsResponse> {
    return this.partnerUsers.partnerAccounts();
  }

  /**
   * Creates a partner login bound to a partner account and returns it with how the person gets in.
   * 409 `EMAIL_TAKEN`; 422 `UNKNOWN_PARTNER_ACCOUNT`.
   */
  @Post()
  create(
    @Body(new ZodBodyPipe(CreatePartnerUserRequest)) body: CreatePartnerUserRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<CreatePartnerUserResponse> {
    return this.partnerUsers.create(body, actorOf(request));
  }

  /** One partner login's detail; 404 for a staff id. */
  @Get(':id')
  get(@Param('id') id: string): Promise<PartnerUserDetail> {
    return this.partnerUsers.get(id);
  }

  /** Changes a partner user's details (never their account: `PUT :id/access`). */
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodBodyPipe(UpdatePartnerUserRequest)) body: UpdatePartnerUserRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<PartnerUserDetail> {
    return this.partnerUsers.update(id, body, actorOf(request));
  }

  /**
   * Binds the partner user to another partner account (spec 0008, AC-12) and ends every session
   * of theirs in the same transaction. 409 `STALE_RECORD`; 422 `UNKNOWN_PARTNER_ACCOUNT`; 404.
   */
  @Put(':id/access')
  move(
    @Param('id') id: string,
    @Body(new ZodBodyPipe(PartnerAccessRequest)) body: PartnerAccessRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<PartnerUserDetail> {
    return this.partnerUsers.move(id, body, actorOf(request));
  }

  /** Disables a partner login with an optional reason; ends its sessions and invalidates its links. */
  @Post(':id/disable')
  @HttpCode(200)
  disable(
    @Param('id') id: string,
    @Body(new ZodBodyPipe(DisableStaffRequest)) body: DisableStaffRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<PartnerUserDetail> {
    return this.partnerUsers.disable(id, body.reason, actorOf(request));
  }

  /** Re-enables a disabled partner login. */
  @Post(':id/enable')
  @HttpCode(200)
  enable(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PartnerUserDetail> {
    return this.partnerUsers.enable(id, actorOf(request));
  }

  /** Resets a partner user's password, by email or with a temporary password. */
  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<ResetStaffPasswordResponse> {
    return this.partnerUsers.resetPassword(id, actorOf(request));
  }

  /** Sends a new invite to a partner login that has never signed in. */
  @Post(':id/resend-invite')
  @HttpCode(200)
  resendInvite(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ ok: true }> {
    return this.partnerUsers.resendInvite(id, actorOf(request));
  }

  /** Turns off a partner user's two factor and ends their sessions. */
  @Post(':id/reset-two-factor')
  @HttpCode(200)
  resetTwoFactor(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<PartnerUserDetail> {
    return this.partnerUsers.resetTwoFactor(id, actorOf(request));
  }

  /** Signs a partner user out everywhere. */
  @Post(':id/revoke-sessions')
  @HttpCode(200)
  revokeSessions(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RevokeSessionsResponse> {
    return this.partnerUsers.revokeSessions(id, actorOf(request));
  }
}
