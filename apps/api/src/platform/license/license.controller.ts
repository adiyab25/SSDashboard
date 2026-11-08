import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common';
import {
  isRunnableState,
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
import { ModuleStateService } from '../modules/module-state.service.js';
import { RequiresModule } from '../modules/requires-module.decorator.js';
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
@RequiresModule('platform')
@Controller('platform/license')
export class LicenseController {
  /** Takes the license service and the module states (the steps an upload resumes). */
  constructor(
    @Inject(LicenseService) private readonly license: LicenseService,
    @Inject(ModuleStateService) private readonly states: ModuleStateService,
  ) {}

  /**
   * The license summary (AC-26), with `resumingSteps`: the executing steps switched on that wait
   * for a renewal because their bundle is in its wind down or `off` (AC-19).
   */
  @Get()
  async summary(): Promise<LicenseSummary> {
    return this.summaryWithSteps();
  }

  /**
   * Uploads a license file (AC-19, AC-20): 200 with the summary, `changed` (false for a license
   * that grants nothing new), and `resumingSteps`, the executing steps switched on that could not
   * run before the upload and run after it (a renewal out of the wind down or `off`; they act only
   * on new events, AC-27); 422 `LICENSE_INVALID` with the check `outcome`, 413
   * `LICENSE_TOO_LARGE`, 422 `VALIDATION_FAILED` for a body that is not `{ envelope }`.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async upload(
    @Body(new ZodBodyPipe(PostLicenseBody)) body: PostLicenseBody,
    @CurrentAccess() access: Access,
  ): Promise<PostLicenseAnswer> {
    try {
      const before = await this.states.states({ fresh: true });
      const { changed } = await this.license.upload(body.envelope, {
        userId: access.userId,
        hat: access.actingHat('settings.manage'),
      });
      const after = changed ? await this.states.states({ fresh: true }) : before;
      const resumingSteps = [...after.steps]
        .filter(([step, state]) => {
          const was = before.steps.get(step);
          return state.state === 'on' && (was === undefined || !isRunnableState(was));
        })
        .map(([step]) => step);
      return { summary: await this.summaryWithSteps(), changed, resumingSteps };
    } catch (error) {
      throw licenseHttpError(error) ?? auditHttpError(error) ?? error;
    }
  }

  /** The summary with the steps a renewal would resume. */
  private async summaryWithSteps(): Promise<LicenseSummary> {
    const [summary, resumingSteps] = await Promise.all([
      this.license.summary(),
      this.states.resumableSteps(),
    ]);
    return { ...summary, resumingSteps };
  }
}
