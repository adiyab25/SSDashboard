import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  addDays,
  bundleEntitlement,
  bundleStanding,
  isLicensedNow,
  isLicenseCheckProblem,
  LICENSE_ENVELOPE_MAX_BYTES,
  LicenseBundle,
  licenseNoticeLevel,
  type AuditActor,
  type BundleFacts,
  type BundleStanding,
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
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService } from '../../audit/audit.service.js';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { DATABASE } from '../../database/database.module.js';
import type { Executor, Transaction } from '../../database/sql.js';
import { PLATFORM_CHANGED_CHANNEL } from '../settings/platform-changes-listener.js';
import { localDate, SettingsService } from '../settings/settings.service.js';
import { LICENSE_CHANGED, LicenseChanged } from './license-events.js';
import { LicenseError } from './license.errors.js';
import {
  LicenseVerifier,
  type InstallIdentity,
  type LicenseVerification,
} from './license-verifier.js';
import { PlatformClock } from './platform-clock.js';

/** The advisory lock every check takes, so concurrent checks record one after another. */
export const LICENSE_CHECK_LOCK = 'ssd.license_check';
/** The `NOTIFY ssd_platform_changed` payload a phase change sends to other processes. */
export const LICENSE_CHANGED_PAYLOAD = 'license';
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

/** The Operations wind down (spec 0009, AC-18), for milestone 4 and the screen. */
export interface OperationsWindDown {
  phase: 'wind_down' | 'off';
  lapsesOn: string;
  lapsedAt: string;
  /** The last day it can last until (the lapse plus `operations_wind_down_days`). */
  windDownEndsOn: string;
  /** The day the pickup window ends (the lapse plus `operations_wind_down_pickup_days`). */
  pickupWindowEndsOn: string;
  /** When a check recorded the end of this lapse's wind down, or null while it runs. */
  endedAt: string | null;
}

/**
 * The license (spec 0009, AC-14 to AC-17, AC-20, AC-26): verifies the file at `LICENSE_FILE`
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
 * and the worker starting together emit it once. A missing or bad file changes nothing but its
 * check row and one error log line (outcome and SHA 256, never the content). It reads time only
 * through `PlatformClock`, never opens a network connection, and never logs a license's content.
 */
@Injectable()
export class LicenseService {
  private readonly logger = new Logger('License');
  private installIdentity: Promise<InstallIdentity> | undefined;
  /**
   * Whether each recorded license row verifies, by row id. A row never changes (append only, its
   * id stamped by the database) and the keys and the install are fixed for the process, so one
   * verification per row and process is enough.
   */
  private readonly rowTrust = new Map<string, boolean>();

  /** Takes the database, env (`LICENSE_FILE`), verifier, clock, settings, audit, and events. */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(ENV) private readonly env: Env,
    @Inject(LicenseVerifier) private readonly verifier: LicenseVerifier,
    @Inject(PlatformClock) private readonly clock: PlatformClock,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(EventEmitter2) private readonly events: EventEmitter2,
  ) {}

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
   * phase on that day, level, days left, the lapse instant, and the wind down's last day. The
   * daily report levels and the staff notice come with milestone 4.
   */
  async notice(day?: string): Promise<LicenseNotice[]> {
    const state = await this.state(this.connection.db);
    if (day === undefined || day === state.today) return this.notices(state);
    return this.notices({
      ...state,
      today: day,
      standings: standingsOf(state.licenses, day, state.facts, state.latest),
    });
  }

  /**
   * The Operations wind down now (AC-18), or null when Operations is not lapsed. `endedAt` is the
   * end the latest check recorded, only when it belongs to the current lapse (between the lapse
   * day and today). Milestone 4 builds the lapse handling on it.
   */
  async windDown(): Promise<OperationsWindDown | null> {
    const state = await this.state(this.connection.db);
    const operations = state.standings.operations;
    const { phase, lapsesOn, windDownEndsOn } = operations;
    if ((phase !== 'wind_down' && phase !== 'off') || !lapsesOn || !windDownEndsOn) return null;
    const ended = state.latest?.wind_down_ended_at ?? null;
    const endedOn = ended ? localDate(new Date(ended), state.facts.timezone) : null;
    return {
      phase,
      lapsesOn,
      lapsedAt: await this.localMidnight(lapsesOn, state.facts.timezone),
      windDownEndsOn,
      pickupWindowEndsOn: addDays(lapsesOn, state.facts.pickupDays),
      endedAt: endedOn !== null && endedOn >= lapsesOn && endedOn <= state.today ? ended : null,
    };
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
   * `bundleFacts` and today's manager notices (`notice()`) from one reading of the state, for the
   * module state snapshot, which caches both (security review m3, finding 6).
   */
  async moduleFacts(
    executor: Executor = this.connection.db,
  ): Promise<{ bundles: Record<LicenseBundle, BundleFacts>; notices: LicenseNotice[] }> {
    const state = await this.state(executor);
    return { bundles: await this.factsOf(state, executor), notices: await this.notices(state) };
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
          ? await this.localMidnight(standing.lapsesOn, state.facts.timezone)
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
    const { result, checkedAt, before } = await this.connection.db.transaction(async (tx) => {
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
      const { operations, warehouse } = standingsOf(after, prior.today, prior.facts, prior.latest);
      const previousEnd = prior.latest?.wind_down_ended_at ?? null;
      const endedOn = previousEnd ? localDate(new Date(previousEnd), prior.facts.timezone) : null;
      // The wind down ends once for each lapse: an end of an earlier lapse, or one recorded while
      // the clock was ahead, is kept as evidence but no longer counts, so a new one is recorded.
      const endCounts =
        endedOn !== null &&
        operations.lapsesOn !== null &&
        endedOn >= operations.lapsesOn &&
        endedOn <= prior.today;
      const windDownEndedAt =
        operations.phase === 'off' && operations.lapsesOn !== null && !endCounts
          ? now.toISOString()
          : previousEnd;
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
      };
    });

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
    return result;
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
      standings: standingsOf(licenses, today, facts, latest),
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

  /** Local 00:00 of `day` in `timeZone` as a UTC instant, by PostgreSQL's time zone rules. */
  private async localMidnight(day: string, timeZone: string): Promise<string> {
    const { rows } = await this.connection.db.execute<{ at: string }>(sql`
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
 * Both bundles' standings on `today` from the licenses that verify and the sticky wind down end
 * of `latest`. No `pre_lapse` capability is registered before milestone 4, so the open item count
 * is null and the Operations wind down ends only by its length (review M2 code 3); milestone 4
 * passes the registered capabilities' `openItems`.
 */
function standingsOf(
  licenses: readonly LicenseRow[],
  today: string,
  facts: PhaseFacts,
  latest: CheckRow | null,
): Record<LicenseBundle, BundleStanding> {
  const input = {
    today,
    licenses: licenses.map(termsOf),
    windDown: {
      days: facts.windDownDays,
      pickupDays: facts.pickupDays,
      openPreLapseItems: null,
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
