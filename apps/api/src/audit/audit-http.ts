import {
  ConflictException,
  ForbiddenException,
  type HttpException,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditError, UndoNotPossible } from './audit.errors.js';

/**
 * The api edge mapping of the audit domain errors a person can cause (spec 0010, API surface):
 * a missing reason is 422 `REASON_REQUIRED`, a reason over 500 characters 422 `REASON_TOO_LONG`,
 * a typed note where the record type takes a reason code 422 `REASON_INVALID`, a viewer without
 * the read permission 403 `FORBIDDEN`, an unknown entry 404 `ENTRY_NOT_FOUND`, an export over
 * 200,000 rows 413 `EXPORT_TOO_LARGE`, and the undo's refusals (AC-14) 409 `NOT_UNDOABLE`, 409
 * `ALREADY_UNDONE`, and 409 `UNDO_NOT_POSSIBLE` with the owner's `undoCode`. Any controller whose
 * transaction calls
 * `AuditService.record`, and every audit reader route, passes its errors through here first.
 * `UnknownAuditAction`, `AuditRecordTypeMismatch`, `AuditCorrelationMismatch`, and
 * `AuditPersonalDataRefused`, and the undo registry's `AuditUndoHandlerMissing`,
 * `AuditUndoHandlerDuplicate`, and `AuditUndoRecordMismatch` are programming errors: they are not
 * mapped and answer 500. Returns
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
    case 'AuditReadForbidden':
      return new ForbiddenException({ code: 'FORBIDDEN', message: error.message });
    case 'AuditEntryNotFound':
      return new NotFoundException({ code: 'ENTRY_NOT_FOUND', message: error.message });
    case 'AuditExportTooLarge':
      return new PayloadTooLargeException({ code: 'EXPORT_TOO_LARGE', message: error.message });
    case 'NotUndoable':
      return new ConflictException({ code: 'NOT_UNDOABLE', message: error.message });
    case 'AlreadyUndone':
      return new ConflictException({ code: 'ALREADY_UNDONE', message: error.message });
    case 'UndoNotPossible':
      return new ConflictException({
        code: 'UNDO_NOT_POSSIBLE',
        undoCode: error instanceof UndoNotPossible ? error.undoCode : 'UNDO_NOT_POSSIBLE',
        message: error.message,
      });
    case 'UnknownAuditAction':
    case 'AuditRecordTypeMismatch':
    case 'AuditCorrelationMismatch':
    case 'AuditPersonalDataRefused':
    case 'AuditUndoHandlerMissing':
    case 'AuditUndoHandlerDuplicate':
    case 'AuditUndoRecordMismatch':
      return undefined;
  }
}
