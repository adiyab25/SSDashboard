import {
  ConflictException,
  type HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { SettingError } from './settings.errors.js';

/**
 * The api edge mapping of the settings domain errors (spec 0009, AC-3): 404 `SETTING_UNKNOWN`,
 * 422 `SETTING_INVALID` with the schema issues, 422 `REASON_REQUIRED`, 409 `STALE_SETTING`, 409
 * `SETTING_LOCKED`, 409 `NOT_LICENSED`, 409 `MODULE_REQUIRED_BY` with `dependants`, 409
 * `MODULE_REQUIRES` with `requires`, 409 `STEP_PRECONDITION` with `precondition` (spec 0009,
 * AC-21), and 409 `SETTING_UNREADABLE`. Returns undefined for anything it does not map.
 */
export function settingsHttpError(error: unknown): HttpException | undefined {
  if (!(error instanceof SettingError)) return undefined;
  switch (error.kind) {
    case 'SettingUnknown':
      return new NotFoundException({ code: 'SETTING_UNKNOWN', message: error.message });
    case 'SettingInvalid':
      return new UnprocessableEntityException({
        code: 'SETTING_INVALID',
        message: error.message,
        issues: error.issues,
      });
    case 'SettingReasonRequired':
      return new UnprocessableEntityException({ code: 'REASON_REQUIRED', message: error.message });
    case 'StaleSetting':
      return new ConflictException({ code: 'STALE_SETTING', message: error.message });
    case 'SettingLocked':
      return new ConflictException({ code: 'SETTING_LOCKED', message: error.message });
    case 'NotLicensed':
      return new ConflictException({ code: 'NOT_LICENSED', message: error.message });
    case 'ModuleRequiredBy':
      return new ConflictException({
        code: 'MODULE_REQUIRED_BY',
        message: error.message,
        dependants: error.modules,
      });
    case 'ModuleRequires':
      return new ConflictException({
        code: 'MODULE_REQUIRES',
        message: error.message,
        requires: error.modules,
      });
    case 'StepPrecondition':
      return new ConflictException({
        code: 'STEP_PRECONDITION',
        message: error.message,
        precondition: error.precondition,
      });
    // A business read of a fail closed setting; the owning module normally maps it to its own
    // code first (the ledger answers 409 LOCK_DATE_UNREADABLE).
    case 'SettingUnreadable':
      return new ConflictException({ code: 'SETTING_UNREADABLE', message: error.message });
  }
}
