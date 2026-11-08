import {
  ConflictException,
  type HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * A module or capability is not `on` (or not `limited` for a finishing write), raised by
 * `ModuleStateService.assertOn` and `assertMayFinish` (spec 0009, AC-13). Its message names the
 * key, never a record.
 */
export class ModuleOff extends Error {
  /** Takes the module, capability, or step key that is off. */
  constructor(readonly key: string) {
    super(`${key} is not on`);
    this.name = 'ModuleOff';
  }
}

/**
 * A `limited` capability refuses a record opened at or after `before` (spec 0009, AC-8, AC-28):
 * only work already in flight before the lapse or the toggle off may finish.
 */
export class ModuleLimited extends Error {
  /** Takes the capability key and the instant before which records may still finish. */
  constructor(
    readonly key: string,
    readonly before: string,
  ) {
    super(`${key} only finishes records opened before ${before}`);
    this.name = 'ModuleLimited';
  }
}

/**
 * A capability's `offImpact` hook, or the outbound command port, failed while the off dialog asked
 * what turning something off drops (spec 0009, AC-30). The dialog may try again; it never guesses.
 */
export class OffImpactUnavailable extends Error {
  /** Takes the capability whose impact could not be read. */
  constructor(readonly capability: string) {
    super(`What turning ${capability} off drops could not be read`);
    this.name = 'OffImpactUnavailable';
  }
}

/**
 * The api edge mapping of the module domain errors (AC-8, AC-30): 404 `MODULE_OFF`, 409
 * `MODULE_LIMITED` with `before`, 503 `OFF_IMPACT_UNAVAILABLE`. Undefined for anything else, so a
 * caller chains it.
 */
export function moduleHttpError(error: unknown): HttpException | undefined {
  if (error instanceof ModuleOff) {
    return new NotFoundException({ code: 'MODULE_OFF', message: 'Not available on this install.' });
  }
  if (error instanceof ModuleLimited) {
    return new ConflictException({
      code: 'MODULE_LIMITED',
      message: 'Only records from before this stopped can be finished.',
      before: error.before,
    });
  }
  if (error instanceof OffImpactUnavailable) {
    return new ServiceUnavailableException({
      code: 'OFF_IMPACT_UNAVAILABLE',
      message: 'What this change drops could not be read. Try again.',
    });
  }
  return undefined;
}
