import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import {
  PostLicenseBody,
  type LicenseSummary,
  type PostLicenseAnswer,
} from '@ssdashboard/contracts';
import { auditHttpError } from '../../audit/audit-http.js';
import type { Access } from '../access/access.js';
import { CurrentAccess } from '../access/current-access.decorator.js';
import { Permission } from '../access/permission.decorator.js';
import { Audience } from '../audience/audience.decorator.js';
import { ZodBodyPipe } from '../zod-body.pipe.js';
import { licenseHttpError } from './license-http.js';
import { LicenseService } from './license.service.js';

/**
 * The license for the people who manage settings (spec 0009, AC-20, AC-26): what the install is
 * licensed for, and uploading a license file. Staff only, `settings.manage` on every route (spec
 * 0008 route mapping). Holds no rule itself; `LicenseService` does. Never answers a signature, an
 * envelope, or the file's path.
 */
@Audience('staff')
@Permission('settings.manage')
@Controller('platform/license')
export class LicenseController {
  /** Takes the license service. */
  constructor(@Inject(LicenseService) private readonly license: LicenseService) {}

  /** The license summary (AC-26). */
  @Get()
  summary(): Promise<LicenseSummary> {
    return this.license.summary();
  }

  /**
   * Uploads a license file (AC-20): 200 with the summary and `changed` (false for a license that
   * grants nothing new), 422 `LICENSE_INVALID` with the check `outcome`, 413 `LICENSE_TOO_LARGE`,
   * 422 `VALIDATION_FAILED` for a body that is not `{ envelope }`.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async upload(
    @Body(new ZodBodyPipe(PostLicenseBody)) body: PostLicenseBody,
    @CurrentAccess() access: Access,
  ): Promise<PostLicenseAnswer> {
    try {
      const { changed } = await this.license.upload(body.envelope, {
        userId: access.userId,
        hat: access.actingHat('settings.manage'),
      });
      // Renewals out of a lapse resume executing steps from milestone 4 on; none can yet.
      return { summary: await this.license.summary(), changed, resumingSteps: [] };
    } catch (error) {
      throw licenseHttpError(error) ?? auditHttpError(error) ?? error;
    }
  }
}
