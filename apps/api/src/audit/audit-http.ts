import { type HttpException, UnprocessableEntityException } from '@nestjs/common';
import { AuditError } from './audit.errors.js';

/**
 * The api edge mapping of the audit domain errors a person can cause (spec 0010, API surface):
 * a missing reason is 422 `REASON_REQUIRED`, a reason over 500 characters 422 `REASON_TOO_LONG`,
 * and a typed note where the record type takes a reason code 422 `REASON_INVALID`. Any controller
 * whose transaction calls `AuditService.record` passes its errors through here first.
 * `UnknownAuditAction`, `AuditRecordTypeMismatch`, `AuditCorrelationMismatch`, and
 * `AuditPersonalDataRefused` are programming errors: they are not mapped and answer 500. Returns
 * `undefined` for anything it does not map.
 */
export function auditHttpError(error: unknown): HttpException | undefined {
  if (!(error instanceof AuditError)) return undefined;
  switch (error.code) {
    case 'AuditReasonRequired':
      return new UnprocessableEntityException({ code: 'REASON_REQUIRED', message: error.message });
    case 'AuditReasonTooLong':
      return new UnprocessableEntityException({ code: 'REASON_TOO_LONG', message: error.message });
    case 'AuditReasonInvalid':
      return new UnprocessableEntityException({ code: 'REASON_INVALID', message: error.message });
    case 'UnknownAuditAction':
    case 'AuditRecordTypeMismatch':
    case 'AuditCorrelationMismatch':
    case 'AuditPersonalDataRefused':
      return undefined;
  }
}
