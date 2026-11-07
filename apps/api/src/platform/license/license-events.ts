import type { LicensePhase } from '@ssdashboard/contracts';

/** One bundle's phase before and after a check. */
export interface PhaseMove {
  readonly from: LicensePhase;
  readonly to: LicensePhase;
}

/**
 * A license check moved the phase of Operations or Warehouse (spec 0009, AC-18, AC-19), emitted
 * in process by `LicenseService` after the check commits, only by the check that recorded the
 * change (the advisory lock makes two concurrent checks emit it once). Other processes learn of
 * it through `NOTIFY ssd_platform_changed` with the payload `license`. Carries ids and phases
 * only. The module job supervisor of milestones 3 and 4 listens for it.
 */
export class LicenseChanged {
  /** Takes the check that recorded the change, its instant, and both bundles' moves. */
  constructor(
    readonly checkId: string,
    readonly checkedAt: string,
    readonly operations: PhaseMove,
    readonly warehouse: PhaseMove,
  ) {}
}

/** The event name `@OnEvent` listens for: the class name, past tense. */
export const LICENSE_CHANGED = 'LicenseChanged';
