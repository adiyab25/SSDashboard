import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  addDays,
  bundleEntitlement,
  bundleStanding,
  daysBetween,
  inCarrierScope,
  isLicensedNow,
  isLicenseCheckProblem,
  LICENSE_ENVELOPE_MAX_BYTES,
  LicenseBundle,
  licenseDayNotice,
  licenseNoticeLevel,
  type AuditActor,
  type BundleFacts,
  type BundleStanding,
  type CarrierCut,
  type CarrierScopeFacts,
  type LicenseDayNotice,
  type LicenseCheckOutcome,
  type LicenseCheckTrigger,
  type LicenseNotice,
  type LicensePayload,
  type LicensePhase,
  type LicenseSource,
  type LicenseSummary,
  type RecordedLicenseTerms,
  type RecordedLicenseView,
  type SettingBundle,
  type WindDownScopeAnswer,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService } from '../../audit/audit.service.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import type { Executor, Transaction } from '../../database/sql.js';
import { CapabilityHooks } from '../modules/capability-hooks.js';
import { ModuleRegistry } from '../modules/module-registry.js';
import {
  PLATFORM_CHANGED_CHANNEL,
  PlatformChangesListener,
} from '../settings/platform-changes-listener.js';
import { localDate, SettingsService } from '../settings/settings.service.js';
import {
  LICENSE_CHANGED,
  LicenseChanged,
  WIND_DOWN_ENDED,
  WindDownEnded,
} from './license-events.js';
import { LicenseError } from './license.errors.js';
import {
  LicenseVerifier,
  type InstallIdentity,
  type LicenseVerification,
} from './license-verifier.js';
import { PlatformClock } from './platform-clock.js';
import { PreLapseItems } from './pre-lapse-items.js';
import { RENEWAL_BACKFILL_WINDOW_MS, renewalsOf, type CheckPhases } from './renewal-gaps.js';

/** The advisory lock every check takes, so concurrent checks record one after another. */
export const LICENSE_CHECK_LOCK = 'ssd.license_check';
/** The `NOTIFY ssd_platform_changed` payload a phase change sends to other processes. */
export const LICENSE_CHANGED_PAYLOAD = 'license';
/**
 * The `NOTIFY ssd_platform_changed` payload the check that records the end of the Operations wind
 * down sends, so every other process emits `WindDownEnded` too (AC-18).
 */
export const WIND_DOWN_ENDED_PAYLOAD = 'license_wind_down_ended';
/** The `system_job` name on a `license.added` entry recorded by the daily check of the file. */
export const LICENSE_CHECK_JOB_NAME = 'platform.license_check';
/**
 * The `system_job` name on a `license.added` entry recorded by a start check (api or worker
 * start). A start check is no pg-boss job: its `jobId` is a fresh uuid that only ties the check's
 * audit entry together (review M2 code 15).
 */
export const LICENSE_START_CHECK_JOB_NAME = 'platform.license_start_check';
/** A server clock more than this far behind the latest earlier check is `clock_behind`. */
const CLOCK_BEHIND_MS = 24 * 60 * 60 * 1000;
/** `O_NONBLOCK` where the platform has it (not on Windows), so a FIFO never hangs a start. */
const OPEN_NONBLOCK: number = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;

/** An instant column as UTC text with microseconds. */
const instant = (column: string) =>
  sql.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/**
 * The columns of a `licenses` row every read returns. Dates go through `to_char(…, 'YYYY-MM-DD')`,
 * never `::text`, whose form follows the session's `DateStyle`: under a non ISO style every term
 * would differ from its signed payload and no license would count (security third check m2, S1).
 */
const LICENSE_COLUMNS = sql.raw(`id, license_id, key_id, client_code, envelope, payload_sha256,
  to_json(bundles) AS bundles,
  to_char(operations_expires_on, 'YYYY-MM-DD') AS operations_expires_on,
  to_char(warehouse_expires_on, 'YYYY-MM-DD') AS warehouse_expires_on,
  to_char(issued_on, 'YYYY-MM-DD') AS issued_on, source,
  to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at`);

/** A `licenses` row as the reads return it. */
type LicenseRow = {
  id: string;
  license_id: string;
  key_id: string;
  client_code: string;
  envelope: string;
  payload_sha256: string;
  bundles: LicenseBundle[];
  operations_expires_on: string | null;
  warehouse_expires_on: string | null;
  issued_on: string;
  source: LicenseSource;
  recorded_at: string;
};

/** A `license_checks` row as the reads return it. */
type CheckRow = {
  id: string;
  checked_at: string;
  trigger: LicenseCheckTrigger;
  outcome: LicenseCheckOutcome;
  operations_phase: LicensePhase;
  warehouse_phase: LicensePhase;
  wind_down_ended_at: string | null;
  clock_behind: boolean;
};

/** What a check read before recording: a verification, or a file that could not be verified. */
type Found =
  | LicenseVerification
  | {
      verified: false;
      sha256: null;
      /** `bad_format` here is a file over 16 KB, refused unread, so it has no hash. */
      outcome: 'none_configured' | 'file_missing' | 'file_unreadable' | 'bad_format';
    };

/** Who records a license: the manager who uploaded it, or a check of the file. */
type Recorder =
  | { kind: 'person'; userId: string; hat: string }
  | { kind: 'system_job'; name: string; jobId: string };

/** The settings a phase reads. */
type PhaseFacts = { timezone: string; windDownDays: number; pickupDays: number };

/**
 * Where the license stands right now: the recorded licenses that verify (the only ones that
 * count), the latest check (for its sticky wind down end and its phases as evidence), the facts,
 * the instant and local day, and both bundles' standings computed live from them.
 */
type LicenseState = {
  licenses: LicenseRow[];
  latest: CheckRow | null;
  facts: PhaseFacts;
  now: Date;
  today: string;
  standings: Record<LicenseBundle, BundleStanding>;
};

/** What one recorded check did. */
export interface LicenseCheckResult {
  checkId: string;
  outcome: LicenseCheckOutcome;
  operations: LicensePhase;
  warehouse: LicensePhase;
  /** Either phase differs from the previous check's (a `LicenseChanged` was emitted). */
  phaseChanged: boolean;
  /** The entitlement of a bundle grew (a new bundle, a later expiry, or perpetual). */
  entitlementChanged: boolean;
}

/** The Operations wind down (spec 0009, AC-18): its lapse, its last day, and its pickup window. */
export interface OperationsWindDown {
  phase: 'wind_down' | 'off';
  lapsesOn: string;
  lapsedAt: string;
  /** The last day it can last until (the lapse plus `operations_wind_down_days`). */
  windDownEndsOn: string;
  /** The day the pickup window ends (the lapse plus `operations_wind_down_pickup_days`). */
  pickupWindowEndsOn: string;
  /** Local 00:00 of `pickupWindowEndsOn` as a UTC instant. */
  pickupWindowEndsAt: string;
  /** When a check recorded the end of this lapse's wind down, or null while it runs. */
  endedAt: string | null;
}

/**
 * A bundle renewed out of the wind down or `off` (spec 0009, AC-19): the gap from the lapse
 * instant it was renewed from to the renewing check, which every capability of the bundle with a
 * `backfill` hook catches up once.
 */
export interface RenewalGap {
  bundle: LicenseBundle;
  /** The renewing check's `license_checks.seq`, which keys its backfill jobs. */
  seq: string;
  from: string;
  to: string;
}

/**
 * Where carrier work stands against the Operations lapse (AC-18): the cut of a lapse in effect
 * (wind down or `off`), `not_lapsed` while Operations is licensed now, or `not_licensed` when it
 * never was.
 */
export type WindDownScope = CarrierCut | 'not_lapsed' | 'not_licensed';

/**
 * The license (spec 0009, AC-14 to AC-20, AC-26): verifies the file at `LICENSE_FILE`
 * (at api start, worker start, and daily) and uploads, records every verified license in the
 * append only `licenses` (with the `license.added` audit entry) and every check in
 * `license_checks`. The entitlement is the union of the recorded licenses that still verify: a
 * row counts only while its stored envelope verifies with the image's keys for this install and
 * its term columns equal the signed payload, so a row inserted by hand grants nothing (security
 * review M2-2). Every read (`licensedBundles`, `summary`, `notice`, `windDown`) computes the
 * phase live from those licenses, today in the `timezone` setting, and the sticky wind down end
 * of the latest check, which can only restrict. A check runs under one advisory lock and records
 * the phases it computed as evidence; only a check whose recorded phases differ from the previous
 * one's sends `NOTIFY ssd_platform_changed` with `license` and emits `LicenseChanged`, so the api
 * and the worker starting together emit it once. The Operations wind down ends by its length or,
 * once the pickup window has passed, when every `pre_lapse` capability's `openItems` hook reports
 * zero (never while one has no hook); only a check counts and records that end, live reads never
 * do, and `checkIfMoved` (the worker's phase watch, every few minutes) runs a check as soon as the
 * phase a check would record differs from the latest recorded one. The check that records the end
 * emits `WindDownEnded`, sends `NOTIFY` with `license_wind_down_ended` so every other process emits
 * it too, and asks for the `wind_down_ended` manager task, once per lapse (AC-18). It answers the wind down
 * scope of carrier work (`windDownScope`, `inWindDownScope`) and the renewal gaps the supervisor
 * backfills (`renewalGaps`). A missing or bad file changes nothing but its
 * check row and one error log line (outcome and SHA 256, never the content). It reads time only
 * through `PlatformClock`, never opens a network connection, and never logs a license's content.
 */
@Injectable()
export class LicenseService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('License');
  /**
   * The wind down ends this process emitted `WindDownEnded` for (or recorded itself), by the
   * recorded end instant as the column reads back, so each end is announced once per process.
   */
  private readonly emittedEnds = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  private installIdentity: Promise<InstallIdentity> | undefined;
  /**
   * Whether each recorded license row verifies, by row id. A row never changes (append only, its
   * id stamped by the database) and the keys and the install are fixed for the process, so one
   * verification per row and process is enough.
   */
  private readonly rowTrust = new Map<string, boolean>();

  /**
   * Takes the database, env (`LICENSE_FILE`), verifier, clock, settings, audit, events, the module
   * registry (the day notice's work), the capability hooks (the manager task port), the open wind
   * down item count, and the change listener (a wind down end recorded by another process).
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ENV) private readonly env: Env,
    @Inject(LicenseVerifier) private readonly verifier: LicenseVerifier,
    @Inject(PlatformClock) private readonly clock: PlatformClock,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventEmitter2) private readonly events: EventEmitter2,
    @Inject(ModuleRegistry) private readonly registry: ModuleRegistry,
    @Inject(CapabilityHooks) private readonly hooks: CapabilityHooks,
    @Inject(PreLapseItems) private readonly preLapse: PreLapseItems,
    @Inject(PlatformChangesListener) private readonly listener: PlatformChangesListener,
  ) {}

  /** Listens for a wind down end another process recorded. */
  onModuleInit(): void {
    this.unsubscribe = this.listener.subscribe((payload) => {
      if (payload !== WIND_DOWN_ENDED_PAYLOAD) return;
      this.endRecordedElsewhere().catch((error: unknown) => {
        this.logger.error(
          `Reading a wind down end failed: ${error instanceof Error ? error.name : 'error'}`,
        );
      });
    });
  }

  /** Stops listening. */
  onApplicationShutdown(): void {
    this.unsubscribe?.();
  }

  /**
   * The worker's phase watch (AC-18): runs a `daily` check when the phases a check would record
   * now (with the open wind down items counted) differ from the latest recorded ones, so the lapse
   * instant, the end of the wind down by its length, and its early end are recorded within minutes,
   * with their `LicenseChanged`, and the supervisor follows. Null when nothing moved.
   */
  async checkIfMoved(jobId: string = randomUUID()): Promise<LicenseCheckResult | null> {
    const state = await this.state(this.connection.db);
    const counted = await this.openItemsFor(state);
    const { operations, warehouse } = standingsOf(
      state.licenses,
      state.today,
      state.facts,
      state.latest,
      counted?.open ?? null,
    );
    if (
      state.latest?.operations_phase === operations.phase &&
      state.latest.warehouse_phase === warehouse.phase
    ) {
      return null;
    }
    return this.checkFile('daily', jobId);
  }

  /**
   * Checks the file at `LICENSE_FILE` (AC-14, AC-16) and records the outcome: `none_configured`
   * when unset, `file_missing`, `file_unreadable`, a verifier refusal, `valid` for a license not
   * recorded before (added to `licenses`, audited with a `system_job` actor), or
   * `already_recorded`. `jobId` is the pg-boss job of the daily check; a start check (`api_start`,
   * `worker_start`) is no job and audits as `platform.license_start_check` with a fresh uuid that
   * only ties its entry together. Throws only when the database fails; the callers log and keep
   * running.
   */
  async checkFile(
    trigger: Exclude<LicenseCheckTrigger, 'upload'>,
    jobId: string = randomUUID(),
  ): Promise<LicenseCheckResult> {
    const found = await this.readFile();
    const name = trigger === 'daily' ? LICENSE_CHECK_JOB_NAME : LICENSE_START_CHECK_JOB_NAME;
    return this.record(trigger, found, 'file', { kind: 'system_job', name, jobId });
  }

  /**
   * Verifies and records an uploaded license (AC-20) for the manager `actor`. Throws
   * `LicenseTooLarge` above 16 KB (nothing recorded) and `LicenseInvalid` with the outcome after
   * recording the refused check. Answers whether the entitlement grew: an older license is
   * recorded and answers `changed: false`; the same license again (whatever its envelope's
   * layout) is `already_recorded`, writes no license row and no audit entry, and answers
   * `changed: false` too.
   */
  async upload(
    envelope: string,
    actor: { userId: string; hat: string },
  ): Promise<{ changed: boolean }> {
    const bytes = Buffer.from(envelope, 'utf8');
    if (bytes.byteLength > LICENSE_ENVELOPE_MAX_BYTES) {
      throw new LicenseError('LicenseTooLarge', 'A license file is at most 16 KB');
    }
    const found = this.verifier.verify(bytes, await this.install());
    const result = await this.record('upload', found, 'upload', { kind: 'person', ...actor });
    if (isLicenseCheckProblem(result.outcome)) {
      throw new LicenseError('LicenseInvalid', 'The license did not verify', result.outcome);
    }
    return { changed: result.entitlementChanged };
  }

  /**
   * `GET /api/platform/license` (AC-26): each bundle's live phase with its expiry or perpetual
   * and days left, the latest file check, every recorded license that verifies (never its
   * envelope or signature), and today's notices, all from one reading of the state.
   */
  async summary(): Promise<LicenseSummary> {
    const db = this.connection.db;
    const [state, lastFile] = await Promise.all([this.state(db), this.latestCheck(db, true)]);
    const bundles = await Promise.all(
      LicenseBundle.options.map(async (bundle) => {
        const standing = state.standings[bundle];
        return {
          bundle,
          phase: standing.phase,
          perpetual: standing.perpetual,
          expiresOn: standing.expiresOn,
          daysLeft: standing.daysLeft,
          lapsesAt: standing.lapsesOn
            ? await this.localMidnight(standing.lapsesOn, state.facts.timezone)
            : null,
        };
      }),
    );
    return {
      bundles,
      lastCheck: lastFile
        ? {
            checkedAt: lastFile.checked_at,
            trigger: lastFile.trigger,
            outcome: lastFile.outcome,
            clockBehind: lastFile.clock_behind,
          }
        : null,
      licenses: state.licenses.map(viewOf),
      notices: await this.notices(state),
    };
  }

  /**
   * The manager's notices for `day` (default today, the local date in `timezone`), AC-17: one per
   * bundle with an expiry from 30 days before it through grace, the wind down, and off, with its
   * phase on that day, level, days left, the lapse instant, the wind down's last day, whether the
   * daily report carries it that day (days 30, 14, and 7 before expiry, every grace and wind down
   * day), what stops at the lapse, and what continues and until when (`LicenseDayNotice`). The
   * staff notice is `staffNotices` over these, by `workOf`.
   */
  async notice(day?: string): Promise<LicenseDayNotice[]> {
    const state = await this.state(this.connection.db);
    const notices =
      day === undefined || day === state.today
        ? await this.notices(state)
        : await this.notices({
            ...state,
            today: day,
            standings: standingsOf(state.licenses, day, state.facts, state.latest, null),
          });
    const modules = this.registry.modules();
    return notices.map((notice) => licenseDayNotice(modules, notice));
  }

  /**
   * The Operations wind down now (AC-18), or null when Operations is not lapsed. `endedAt` is the
   * end the latest check recorded, only when it belongs to the current lapse (between the lapse
   * day and today). `windDownScope` and the supervisor build on it.
   */
  async windDown(): Promise<OperationsWindDown | null> {
    const state = await this.state(this.connection.db);
    const operations = state.standings.operations;
    const { phase, lapsesOn, windDownEndsOn } = operations;
    if ((phase !== 'wind_down' && phase !== 'off') || !lapsesOn || !windDownEndsOn) return null;
    const ended = state.latest?.wind_down_ended_at ?? null;
    const endedOn = ended ? localDate(new Date(ended), state.facts.timezone) : null;
    const pickupWindowEndsOn = addDays(lapsesOn, state.facts.pickupDays);
    return {
      phase,
      lapsesOn,
      lapsedAt: await this.localMidnight(lapsesOn, state.facts.timezone),
      windDownEndsOn,
      pickupWindowEndsOn,
      pickupWindowEndsAt: await this.localMidnight(pickupWindowEndsOn, state.facts.timezone),
      endedAt: endedOn !== null && endedOn >= lapsesOn && endedOn <= state.today ? ended : null,
    };
  }

  /**
   * Where carrier work stands against the Operations lapse (AC-18, task 21): the cut of a lapse in
   * effect (the lapse instant and local 00:00 of the lapse day plus
   * `operations_wind_down_pickup_days`), `not_lapsed` while Operations is licensed now, or
   * `not_licensed` when it never was. A sweep reads it once and applies the pure `inCarrierScope`
   * to each delivery; it must still run only while its capability is runnable.
   */
  async windDownScope(): Promise<WindDownScope> {
    const state = await this.state(this.connection.db);
    const phase = state.standings.operations.phase;
    if (phase === 'not_licensed') return 'not_licensed';
    return (await this.cutOf(state, this.connection.db)) ?? 'not_lapsed';
  }

  /**
   * Where a carrier delivery stands against the Operations wind down (AC-18, D5, task 21):
   * `in_scope` when the carrier created it before the lapse instant (its own creation time, never
   * when the app discovered it), or its order was confirmed before the lapse and the carrier
   * created it before the pickup window ended; `out_of_scope` for any other delivery of a lapse, and
   * for every delivery while Operations was never licensed; `not_lapsed` while Operations is
   * licensed now. It never changes anything, and callers must also check the module state of the
   * capability that would follow the delivery (`ModuleStateService.acceptsHook`, the job gate):
   * after the wind down ends nothing is followed whatever this says.
   */
  async inWindDownScope(facts: CarrierScopeFacts): Promise<WindDownScopeAnswer> {
    const scope = await this.windDownScope();
    if (scope === 'not_lapsed') return 'not_lapsed';
    if (scope === 'not_licensed') return 'out_of_scope';
    return inCarrierScope(facts, scope) ? 'in_scope' : 'out_of_scope';
  }

  /**
   * Every renewal out of the wind down or `off` whose check is younger than
   * `RENEWAL_BACKFILL_WINDOW_MS` by the platform clock (AC-19, `renewalsOf`): the renewing check's
   * `seq`, the lapse instant it was renewed from (from the licenses recorded before that check, in
   * the current `timezone`), and the check's instant. A move out of `grace`, or back without a
   * lapse behind it (a clock set back), gives none.
   */
  async renewalGaps(): Promise<RenewalGap[]> {
    const db = this.connection.db;
    const now = (await this.clock.now(db)).getTime();
    const cutoff = new Date(now - RENEWAL_BACKFILL_WINDOW_MS).toISOString();
    // From the last check before the window, so the first move inside it has its prior phase.
    const { rows: checks } = await db.execute<CheckPhases & Record<string, unknown>>(sql`
      SELECT seq::text AS seq, ${instant('checked_at')} AS "checkedAt",
             operations_phase AS operations, warehouse_phase AS warehouse
      FROM license_checks
      WHERE seq >= COALESCE((SELECT max(seq) FROM license_checks
                             WHERE checked_at <= ${cutoff}::timestamptz), 0)
      ORDER BY seq`);
    if (checks.length < 2) return [];
    const licenses = await this.trustedLicenses(db);
    const { timezone } = await this.facts(db);
    // Each license row was added by exactly one `valid` check, in the same transaction.
    const recorded = await db.execute<{ id: string; seq: string }>(sql`
      SELECT license_row_id::text AS id, min(seq)::text AS seq FROM license_checks
      WHERE outcome = 'valid' AND license_row_id IS NOT NULL GROUP BY license_row_id`);
    const seqOf = new Map(recorded.rows.map((row) => [row.id, row.seq]));
    const renewals = renewalsOf(
      checks,
      licenses.flatMap((license) => {
        const recordedSeq = seqOf.get(license.id);
        return recordedSeq === undefined ? [] : [{ terms: termsOf(license), recordedSeq }];
      }),
      {
        now,
        windowMs: RENEWAL_BACKFILL_WINDOW_MS,
        localDay: (at) => localDate(new Date(at), timezone),
      },
    );
    const gaps: RenewalGap[] = [];
    for (const renewal of renewals) {
      gaps.push({
        bundle: renewal.bundle,
        seq: renewal.seq,
        from: await this.localMidnight(renewal.lapsesOn, timezone, db),
        to: renewal.at,
      });
    }
    return gaps;
  }

  /**
   * The bundles licensed now (spec 0009, *Effective state*): `core` always, and each bundle whose
   * live phase is `active`, `expiring`, or `grace`. With no license that verifies, only core.
   */
  async licensedBundles(
    executor: Executor = this.connection.db,
  ): Promise<ReadonlySet<SettingBundle>> {
    const { standings } = await this.state(executor);
    const licensed = new Set<SettingBundle>(['core']);
    for (const bundle of LicenseBundle.options) {
      if (isLicensedNow(standings[bundle].phase)) licensed.add(bundle);
    }
    return licensed;
  }

  /**
   * Each bundle's facts for `moduleStates` (spec 0009, AC-7): its live phase (computed like every
   * other read, never the phase a check recorded), the lapse instant (local 00:00 of expiry plus
   * 15 in `timezone`, null without an expiry), and the instant of the last check that renewed it
   * out of `wind_down` or `off` (the `since` watermark of AC-27; null when never).
   */
  async bundleFacts(
    executor: Executor = this.connection.db,
  ): Promise<Record<LicenseBundle, BundleFacts>> {
    return this.factsOf(await this.state(executor), executor);
  }

  /**
   * `bundleFacts`, today's manager notices (`notice()`), and the cut of an Operations lapse in
   * effect (null without one) from one reading of the state, for the module state snapshot, which
   * caches all three (security review m3, finding 6), so a hook event never reads the license.
   */
  async moduleFacts(executor: Executor = this.connection.db): Promise<{
    bundles: Record<LicenseBundle, BundleFacts>;
    notices: LicenseNotice[];
    windDownCut: CarrierCut | null;
  }> {
    const state = await this.state(executor);
    return {
      bundles: await this.factsOf(state, executor),
      notices: await this.notices(state),
      windDownCut: await this.cutOf(state, executor),
    };
  }

  /** The cut of an Operations lapse in effect (wind down or `off`), or null without one. */
  private async cutOf(state: LicenseState, executor: Executor): Promise<CarrierCut | null> {
    const { phase, lapsesOn } = state.standings.operations;
    if ((phase !== 'wind_down' && phase !== 'off') || lapsesOn === null) return null;
    const pickupEnds = addDays(lapsesOn, state.facts.pickupDays);
    return {
      cutAt: await this.localMidnight(lapsesOn, state.facts.timezone, executor),
      pickupWindowEndsAt: await this.localMidnight(pickupEnds, state.facts.timezone, executor),
    };
  }

  /**
   * The open wind down items when they can decide the phase (Operations in its wind down with the
   * pickup window passed), with the lapse day they were counted for; null otherwise or when they
   * cannot be counted. Only a check (and the phase watch) counts; live reads never do.
   */
  private async openItemsFor(
    state: LicenseState,
  ): Promise<{ lapsesOn: string; open: number } | null> {
    const operations = state.standings.operations;
    if (
      operations.phase !== 'wind_down' ||
      operations.lapsesOn === null ||
      daysBetween(operations.lapsesOn, state.today) < state.facts.pickupDays
    ) {
      return null;
    }
    const cut = await this.cutOf(state, this.connection.db);
    if (cut === null) return null;
    const open = await this.preLapse.count({
      before: cut.cutAt,
      pickupWindowEndsAt: cut.pickupWindowEndsAt,
    });
    return open === null ? null : { lapsesOn: operations.lapsesOn, open };
  }

  /** Each bundle's facts from one reading of the state. */
  private async factsOf(
    state: LicenseState,
    executor: Executor,
  ): Promise<Record<LicenseBundle, BundleFacts>> {
    const { rows } = await executor.execute<{ bundle: LicenseBundle; at: string }>(sql`
      SELECT bundle, ${instant('max(checked_at)')} AS at
      FROM (SELECT 'operations' AS bundle, checked_at, operations_phase::text AS phase,
                   lag(operations_phase::text) OVER (ORDER BY seq) AS prior
              FROM license_checks
            UNION ALL
            SELECT 'warehouse', checked_at, warehouse_phase::text,
                   lag(warehouse_phase::text) OVER (ORDER BY seq)
              FROM license_checks) moves
      WHERE prior IN ('wind_down', 'off') AND phase IN ('active', 'expiring', 'grace')
      GROUP BY bundle`);
    const renewed = new Map(rows.map((row) => [row.bundle, row.at]));
    const facts = {} as Record<LicenseBundle, BundleFacts>;
    for (const bundle of LicenseBundle.options) {
      const standing = state.standings[bundle];
      facts[bundle] = {
        phase: standing.phase,
        lapsedAt: standing.lapsesOn
          ? await this.localMidnight(standing.lapsesOn, state.facts.timezone, executor)
          : null,
        renewedAt: renewed.get(bundle) ?? null,
      };
    }
    return facts;
  }

  /**
   * Reads the license file without ever logging or returning its content (security review M2-7):
   * opened non blocking, so a FIFO never hangs a start; only a regular file is read; at most
   * 16 KB plus one byte is read, through the handle, so a huge or growing file is refused
   * (`bad_format`, with no hash) rather than read whole.
   */
  private async readFile(): Promise<Found> {
    const path = this.env.LICENSE_FILE;
    if (!path) return { verified: false, sha256: null, outcome: 'none_configured' };
    let bytes: Buffer;
    try {
      const handle = await open(path, constants.O_RDONLY | OPEN_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return { verified: false, sha256: null, outcome: 'file_unreadable' };
        const buffer = Buffer.alloc(LICENSE_ENVELOPE_MAX_BYTES + 1);
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        if (filled > LICENSE_ENVELOPE_MAX_BYTES) {
          return { verified: false, sha256: null, outcome: 'bad_format' };
        }
        bytes = buffer.subarray(0, filled);
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return {
        verified: false,
        sha256: null,
        outcome: code === 'ENOENT' || code === 'ENOTDIR' ? 'file_missing' : 'file_unreadable',
      };
    }
    return this.verifier.verify(bytes, await this.install());
  }

  /**
   * Records one check (AC-14, AC-16, AC-20) in one transaction under the check lock: reads the
   * clock after the lock, adds a verified license not recorded before (`valid`, audited) or finds
   * it by its payload among the rows that verify (`already_recorded`; a planted row with the same
   * hash is not one of them), judges both phases from the licenses that verify,
   * today in `timezone`, and the wind down settings, records the check row (with `clock_behind`
   * and the wind down end carried forward), and notifies other processes when a recorded phase
   * moved. After the commit it emits `LicenseChanged` for a moved phase and logs one line: an
   * error with the outcome and SHA 256 for a problem.
   */
  private async record(
    trigger: LicenseCheckTrigger,
    found: Found,
    source: LicenseSource,
    recorder: Recorder,
  ): Promise<LicenseCheckResult> {
    const actor: AuditActor =
      recorder.kind === 'person'
        ? { kind: 'person', userId: recorder.userId, hat: recorder.hat }
        : { kind: 'system_job', name: recorder.name, jobId: recorder.jobId };
    // Made before the transaction opens (AuditService's rule).
    const correlationId = this.audit.newCorrelationId(actor);
    // Counted once, before the locked transaction, so no hook runs while the lock and its
    // connection are held; a count taken for another lapse than the one judged inside is dropped.
    const counted = await this.openItemsFor(await this.state(this.connection.db));
    const { result, checkedAt, before, ended } = await this.connection.db.transaction(
      async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LICENSE_CHECK_LOCK}))`);
        // After the lock: a check that waited judges the day after its wait (review M2 code 2).
        const now = await this.clock.now(tx);
        const latestCheckedAt = await this.latestCheckedAt(tx);
        const prior = await this.state(tx, now);

        let outcome: LicenseCheckOutcome;
        let licenseRowId: string | null = null;
        let added: LicenseRow | null = null;
        if (found.verified) {
          // A duplicate only of a row that verifies, found under the check lock (security re-review
          // R2): a row planted with this license's payload hash grants nothing and never stops the
          // license itself from being recorded and counted.
          const recorded = prior.licenses.find((row) => row.payload_sha256 === found.payloadSha256);
          if (recorded) {
            outcome = 'already_recorded';
            licenseRowId = recorded.id;
          } else {
            added = await this.insertLicense(tx, found, source, recorder);
            outcome = 'valid';
            licenseRowId = added.id;
            this.rowTrust.set(added.id, true);
          }
        } else {
          outcome = found.outcome;
        }

        const after = added ? [...prior.licenses, added] : prior.licenses;
        const bare = standingsOf(after, prior.today, prior.facts, prior.latest, null);
        const open =
          counted !== null && counted.lapsesOn === bare.operations.lapsesOn ? counted.open : null;
        const { operations, warehouse } =
          open === null ? bare : standingsOf(after, prior.today, prior.facts, prior.latest, open);
        const previousEnd = prior.latest?.wind_down_ended_at ?? null;
        const endedOn = previousEnd ? localDate(new Date(previousEnd), prior.facts.timezone) : null;
        // The wind down ends once for each lapse: an end of an earlier lapse, or one recorded while
        // the clock was ahead, is kept as evidence but no longer counts, so a new one is recorded.
        const endCounts =
          endedOn !== null &&
          operations.lapsesOn !== null &&
          endedOn >= operations.lapsesOn &&
          endedOn <= prior.today;
        const endRecorded =
          operations.phase === 'off' && operations.lapsesOn !== null && !endCounts;
        const windDownEndedAt = endRecorded ? now.toISOString() : previousEnd;
        const clockBehind =
          latestCheckedAt !== null &&
          now.getTime() < new Date(latestCheckedAt).getTime() - CLOCK_BEHIND_MS;

        const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO license_checks (checked_at, trigger, outcome, file_sha256, license_row_id,
                                    operations_phase, warehouse_phase, wind_down_ended_at, clock_behind)
        VALUES (${now.toISOString()}::timestamptz, ${trigger}, ${outcome}, ${found.sha256},
                ${licenseRowId}::uuid, ${operations.phase}, ${warehouse.phase},
                ${windDownEndedAt}::timestamptz, ${clockBehind})
        RETURNING id`);
        const checkId = rows[0]?.id as string;
        if (endRecorded) {
          // Marked before the commit, so this process's listener never emits it a second time.
          this.emittedEnds.add(endedAtRead(now));
          await tx.execute(
            sql`SELECT pg_notify(${PLATFORM_CHANGED_CHANNEL}, ${WIND_DOWN_ENDED_PAYLOAD})`,
          );
        }

        if (added && found.verified) {
          const { payload } = found;
          await this.audit.record(tx, {
            actor,
            action: 'license.added',
            record: { type: 'license', id: added.id, label: payload.licenseId },
            after: {
              licenseId: payload.licenseId,
              keyId: found.keyId,
              bundles: [...payload.bundles],
              operationsExpiresOn: payload.operationsExpiresOn ?? null,
              warehouseExpiresOn: payload.warehouseExpiresOn ?? null,
              issuedOn: payload.issuedOn,
              source,
            },
            correlationId,
          });
        }

        const from = {
          operations: prior.latest?.operations_phase ?? 'not_licensed',
          warehouse: prior.latest?.warehouse_phase ?? 'not_licensed',
        };
        const phaseChanged =
          from.operations !== operations.phase || from.warehouse !== warehouse.phase;
        if (phaseChanged) {
          await tx.execute(
            sql`SELECT pg_notify(${PLATFORM_CHANGED_CHANNEL}, ${LICENSE_CHANGED_PAYLOAD})`,
          );
        }
        const entitlementChanged = LicenseBundle.options.some((bundle) => {
          const was = bundleEntitlement(bundle, prior.licenses.map(termsOf));
          const is = bundleEntitlement(bundle, after.map(termsOf));
          return (
            was.licensed !== is.licensed ||
            was.perpetual !== is.perpetual ||
            was.expiresOn !== is.expiresOn
          );
        });
        return {
          result: {
            checkId,
            outcome,
            operations: operations.phase,
            warehouse: warehouse.phase,
            phaseChanged,
            entitlementChanged,
          } satisfies LicenseCheckResult,
          checkedAt: now.toISOString(),
          before: from,
          ended:
            endRecorded && operations.lapsesOn !== null
              ? {
                  lapsesOn: operations.lapsesOn,
                  // As the column reads back (microseconds), so every process names the same end.
                  endedAt: endedAtRead(now),
                  timezone: prior.facts.timezone,
                }
              : null,
        };
      },
    );

    if (isLicenseCheckProblem(result.outcome)) {
      this.logger.error(
        `License check (${trigger}): ${result.outcome}; file sha256 ${found.sha256 ?? 'none'}; recorded licenses keep counting`,
      );
    } else {
      this.logger.log(
        `License check (${trigger}): ${result.outcome}; operations ${result.operations}, warehouse ${result.warehouse}`,
      );
    }
    if (result.phaseChanged) {
      try {
        this.events.emit(
          LICENSE_CHANGED,
          new LicenseChanged(
            result.checkId,
            checkedAt,
            { from: before.operations, to: result.operations },
            { from: before.warehouse, to: result.warehouse },
          ),
        );
      } catch {
        // A listener that throws never undoes a recorded check; its error is not ours to print.
        this.logger.error('A LicenseChanged listener failed');
      }
    }
    if (ended) await this.windDownEnded(ended);
    return result;
  }

  /**
   * Another process recorded the end of the Operations wind down (its `NOTIFY`): emits
   * `WindDownEnded` here too, once per recorded end, unless this process recorded or announced it.
   * It reads the end of the current lapse only (`windDown().endedAt`, null when the current lapse
   * has none), so a stray notification during a later lapse never announces an earlier end. The
   * task is the recording process's alone.
   */
  private async endRecordedElsewhere(): Promise<void> {
    const windDown = await this.windDown();
    if (!windDown?.endedAt || this.emittedEnds.has(windDown.endedAt)) return;
    this.emittedEnds.add(windDown.endedAt);
    try {
      this.events.emit(WIND_DOWN_ENDED, new WindDownEnded(windDown.lapsedAt, windDown.endedAt));
    } catch {
      this.logger.error('A WindDownEnded listener failed');
    }
  }

  /**
   * After the check that recorded the end of the Operations wind down commits (AC-18): emits
   * `WindDownEnded` and asks for the one `wind_down_ended` manager task, keyed on the lapse. A
   * failing listener or task port is logged by name and never undoes the recorded check.
   */
  private async windDownEnded(ended: {
    lapsesOn: string;
    endedAt: string;
    timezone: string;
  }): Promise<void> {
    try {
      const lapsedAt = await this.localMidnight(ended.lapsesOn, ended.timezone);
      try {
        this.events.emit(WIND_DOWN_ENDED, new WindDownEnded(lapsedAt, ended.endedAt));
      } catch {
        this.logger.error('A WindDownEnded listener failed');
      }
      await this.hooks.openTask({
        kind: 'wind_down_ended',
        key: lapsedAt,
        lapsedAt,
        endedAt: ended.endedAt,
      });
      this.logger.log(`The Operations wind down of the lapse at ${lapsedAt} ended`);
    } catch (error) {
      this.logger.error(
        `Opening the wind down end task failed: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }

  /**
   * Where the license stands, through `executor`: the licenses that verify, the latest check,
   * the settings, the instant (the given one, else the platform clock), today, and both standings.
   */
  private async state(executor: Executor, now?: Date): Promise<LicenseState> {
    const [licenses, latest, facts] = [
      await this.trustedLicenses(executor),
      await this.latestCheck(executor),
      await this.facts(executor),
    ];
    const instantNow = now ?? (await this.clock.now(executor));
    const today = localDate(instantNow, facts.timezone);
    return {
      licenses,
      latest,
      facts,
      now: instantNow,
      today,
      // Live reads never count open items: only a recorded end ends the wind down early (AC-18).
      standings: standingsOf(licenses, today, facts, latest, null),
    };
  }

  /** The manager's notices of a state (AC-17). */
  private async notices(state: LicenseState): Promise<LicenseNotice[]> {
    const notices: LicenseNotice[] = [];
    for (const bundle of LicenseBundle.options) {
      const standing = state.standings[bundle];
      const level = licenseNoticeLevel(standing);
      if (!level || !standing.expiresOn || standing.lapsesOn === null) continue;
      notices.push({
        bundle,
        phase: standing.phase,
        level,
        expiresOn: standing.expiresOn,
        daysLeft: standing.daysLeft ?? 0,
        lapsesOn: standing.lapsesOn,
        lapsesAt: await this.localMidnight(standing.lapsesOn, state.facts.timezone),
        windDownEndsOn: standing.windDownEndsOn,
      });
    }
    return notices;
  }

  /**
   * Adds a verified license and returns the new row. The caller checked, under the check lock,
   * that no row that verifies holds the same payload.
   */
  private async insertLicense(
    tx: Transaction,
    found: Extract<LicenseVerification, { verified: true }>,
    source: LicenseSource,
    recorder: Recorder,
  ): Promise<LicenseRow> {
    const { payload } = found;
    const { rows } = await tx.execute<LicenseRow>(sql`
      INSERT INTO licenses (license_id, key_id, envelope, sha256, payload_sha256, client_code,
                            bundles, operations_expires_on, warehouse_expires_on, issued_on,
                            source, recorded_by)
      VALUES (${payload.licenseId}, ${found.keyId}, ${found.envelope}, ${found.sha256},
              ${found.payloadSha256}, ${payload.clientCode},
              ${`{${payload.bundles.join(',')}}`}::text[],
              ${payload.operationsExpiresOn ?? null}::date, ${payload.warehouseExpiresOn ?? null}::date,
              ${payload.issuedOn}::date, ${source},
              ${recorder.kind === 'person' ? recorder.userId : null}::uuid)
      RETURNING ${LICENSE_COLUMNS}`);
    return rows[0] as LicenseRow;
  }

  /**
   * Every recorded license that verifies, newest first (security review M2-2): its stored
   * envelope verifies with the image's keys for this install, under the key it names, with the
   * payload hash it holds, and every term column equals the signed payload. Any other row is
   * ignored (it grants nothing) and logged once per process by id.
   */
  private async trustedLicenses(executor: Executor): Promise<LicenseRow[]> {
    const { rows } = await executor.execute<LicenseRow>(
      sql`SELECT ${LICENSE_COLUMNS} FROM licenses ORDER BY recorded_at DESC, id DESC`,
    );
    const trusted: LicenseRow[] = [];
    for (const row of rows) {
      let ok = this.rowTrust.get(row.id);
      if (ok === undefined) {
        const verified = this.verifier.verify(
          Buffer.from(row.envelope, 'utf8'),
          await this.install(),
        );
        ok =
          verified.verified &&
          verified.keyId === row.key_id &&
          verified.payloadSha256 === row.payload_sha256 &&
          termsMatch(verified.payload, row);
        this.rowTrust.set(row.id, ok);
        if (!ok) {
          this.logger.error(
            `License row ${row.id} does not verify against the image's keys and this install; it grants nothing`,
          );
        }
      }
      if (ok) trusted.push(row);
    }
    return trusted;
  }

  /** The latest check row by insert order (`seq`), of the file only when `fileOnly`. */
  private async latestCheck(executor: Executor, fileOnly = false): Promise<CheckRow | null> {
    const { rows } = await executor.execute<CheckRow>(sql`
      SELECT id, ${instant('checked_at')} AS checked_at, trigger, outcome, operations_phase,
             warehouse_phase, ${instant('wind_down_ended_at')} AS wind_down_ended_at, clock_behind
      FROM license_checks
      ${fileOnly ? sql`WHERE trigger <> 'upload'` : sql``}
      ORDER BY seq DESC LIMIT 1`);
    return rows[0] ?? null;
  }

  /** The latest `checked_at` of any earlier check, for `clock_behind`. */
  private async latestCheckedAt(executor: Executor): Promise<string | null> {
    const { rows } = await executor.execute<{ at: string | null }>(
      sql`SELECT ${instant('max(checked_at)')} AS at FROM license_checks`,
    );
    return rows[0]?.at ?? null;
  }

  /** The settings a phase reads, through `executor` (never the stale cache). */
  private async facts(executor: Executor): Promise<PhaseFacts> {
    const values = await this.settings.read(
      ['timezone', 'operations_wind_down_days', 'operations_wind_down_pickup_days'],
      executor,
    );
    return {
      timezone: values.timezone,
      windDownDays: values.operations_wind_down_days,
      pickupDays: values.operations_wind_down_pickup_days,
    };
  }

  /**
   * Local 00:00 of `day` in `timeZone` as a UTC instant, by PostgreSQL's time zone rules, through
   * `executor` (the caller's transaction, so a check holds no second connection).
   */
  private async localMidnight(
    day: string,
    timeZone: string,
    executor: Executor = this.connection.db,
  ): Promise<string> {
    const { rows } = await executor.execute<{ at: string }>(sql`
      SELECT to_char((${day}::date::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
    return rows[0]?.at as string;
  }

  /** The `install` row a license must be bound to; it never changes, so it is read once. */
  private install(): Promise<InstallIdentity> {
    this.installIdentity ??= (async () => {
      const { rows } = await this.connection.db.execute<{ id: string; client_code: string }>(
        sql`SELECT id::text AS id, client_code FROM install`,
      );
      const row = rows[0];
      if (!row) throw new Error('The install row is missing; run migrate first');
      return { id: row.id, clientCode: row.client_code };
    })().catch((error: unknown) => {
      this.installIdentity = undefined;
      throw error;
    });
    return this.installIdentity;
  }
}

/**
 * Both bundles' standings on `today` from the licenses that verify, the sticky wind down end of
 * `latest`, and the open `pre_lapse` items (null when no `pre_lapse` capability counts them: the
 * Operations wind down then ends only by its length, review M2 code 3).
 */
function standingsOf(
  licenses: readonly LicenseRow[],
  today: string,
  facts: PhaseFacts,
  latest: CheckRow | null,
  openPreLapseItems: number | null,
): Record<LicenseBundle, BundleStanding> {
  const input = {
    today,
    licenses: licenses.map(termsOf),
    windDown: {
      days: facts.windDownDays,
      pickupDays: facts.pickupDays,
      openPreLapseItems,
      endedOn: latest?.wind_down_ended_at
        ? localDate(new Date(latest.wind_down_ended_at), facts.timezone)
        : null,
    },
  };
  return {
    warehouse: bundleStanding('warehouse', input),
    operations: bundleStanding('operations', input),
  };
}

/**
 * A check's instant as `wind_down_ended_at` reads back (`to_char` with microseconds): the clock
 * gives milliseconds, so three zeros complete it.
 */
function endedAtRead(now: Date): string {
  return now.toISOString().replace(/Z$/, '000Z');
}

/** Whether a row's term columns equal the payload its envelope signs. */
function termsMatch(payload: LicensePayload, row: LicenseRow): boolean {
  const sorted = (bundles: readonly string[]) => [...bundles].sort().join(',');
  return (
    payload.licenseId === row.license_id &&
    payload.clientCode === row.client_code &&
    sorted(payload.bundles) === sorted(row.bundles) &&
    (payload.operationsExpiresOn ?? null) === row.operations_expires_on &&
    (payload.warehouseExpiresOn ?? null) === row.warehouse_expires_on &&
    payload.issuedOn === row.issued_on
  );
}

/** The terms `bundlePhase` reads from one row. */
function termsOf(row: LicenseRow): RecordedLicenseTerms {
  return {
    bundles: row.bundles,
    operationsExpiresOn: row.operations_expires_on,
    warehouseExpiresOn: row.warehouse_expires_on,
  };
}

/** One recorded license as the summary shows it: never its envelope or signature. */
function viewOf(row: LicenseRow): RecordedLicenseView {
  return {
    id: row.id,
    licenseId: row.license_id,
    bundles: row.bundles,
    operationsExpiresOn: row.operations_expires_on,
    warehouseExpiresOn: row.warehouse_expires_on,
    issuedOn: row.issued_on,
    source: row.source,
    recordedAt: row.recorded_at,
  };
}
