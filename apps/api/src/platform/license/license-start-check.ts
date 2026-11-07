import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { describeError } from '../../database/pg-error.js';
import { LicenseService } from './license.service.js';

/**
 * Checks the license file once when the api starts (spec 0009, AC-14). Provided by
 * `PlatformApiModule`, so only the api runs it; the worker's own start check is in
 * `LicenseCheckJob`. A failure is logged and the api keeps starting: a missing or bad license
 * never stops the process (AC-16).
 */
@Injectable()
export class LicenseStartCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger('License');

  /** Takes the license service. */
  constructor(@Inject(LicenseService) private readonly license: LicenseService) {}

  /** Runs the `api_start` check; never throws. */
  async onApplicationBootstrap(): Promise<void> {
    await this.license.checkFile('api_start').catch((error: unknown) =>
      this.logger.error(
        // Through describeError: a failed query's message carries its params (security M2-5).
        `The license check at api start failed: ${describeError(error)}`,
      ),
    );
  }
}
