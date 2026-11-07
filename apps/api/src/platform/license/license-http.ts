import { HttpException, HttpStatus, UnprocessableEntityException } from '@nestjs/common';
import { LicenseError } from './license.errors.js';

/**
 * The api edge mapping of the license domain errors (spec 0009, API surface): 422
 * `LICENSE_INVALID` with the check `outcome`, and 413 `LICENSE_TOO_LARGE`. Returns undefined for
 * anything it does not map.
 */
export function licenseHttpError(error: unknown): HttpException | undefined {
  if (!(error instanceof LicenseError)) return undefined;
  switch (error.kind) {
    case 'LicenseInvalid':
      return new UnprocessableEntityException({
        code: 'LICENSE_INVALID',
        message: error.message,
        outcome: error.outcome,
      });
    case 'LicenseTooLarge':
      return new HttpException(
        { code: 'LICENSE_TOO_LARGE', message: error.message },
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
  }
}
