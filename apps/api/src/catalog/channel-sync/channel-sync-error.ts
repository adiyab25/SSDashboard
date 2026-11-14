/**
 * Why `CatalogChannelSync` refused a call or stopped (spec 0012 milestone 4 fix round):
 * - `NotReadCommitted`: the caller's transaction is not READ COMMITTED (security review L3); at
 *   REPEATABLE READ the snapshot predates the lock wait and the call would fail with 40001;
 * - `NotSystemJob`: the actor is not a `system_job` (security review L7; AC-17 names the caller's
 *   job as the actor of every channel entry);
 * - `StyleCodeExhausted`: no free style code within `MAX_STYLE_CODE_ATTEMPTS` suffixes;
 * - `UnknownConflict`: an insert hit a unique constraint the sync does not expect (security
 *   review L9), so no outcome would be honest;
 * - `Invariant`: a rule the sync itself keeps was broken (a locked row missing, the seeded `MAIN`
 *   group missing); a defect, never a channel input problem.
 */
export type ChannelSyncErrorCode =
  'NotReadCommitted' | 'NotSystemJob' | 'StyleCodeExhausted' | 'UnknownConflict' | 'Invariant';

/**
 * The typed domain error of the channel sync. Never carries channel text (a title or a tag may
 * hold anything a store typed); the connector (spec 0015) logs the code and lets its job fail.
 */
export class ChannelSyncError extends Error {
  /** Takes the stable `code` and a message safe to log. */
  constructor(
    readonly code: ChannelSyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelSyncError';
  }
}
