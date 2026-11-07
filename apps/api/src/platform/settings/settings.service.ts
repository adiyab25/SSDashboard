import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  isCrossChecked,
  nestsDeeperThan,
  SETTING_VALUE_MAX_DEPTH,
  SETTING_WRITE_DEPENDENCIES,
  settingDefinitionOf,
  settingWriteIssues,
  type SettingDefinition,
  type SettingKey,
  type SettingValues,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { createFormatter } from '@ssdashboard/i18n';
import { AuditService, type JsonValue } from '../../audit/audit.service.js';
import { DATABASE } from '../../database/database.module.js';
import { pgArray, type Executor } from '../../database/sql.js';
import { PLATFORM_CHANGED_CHANNEL } from './platform-changes-listener.js';
import { ReconcileModulesProducer } from './reconcile-modules.queue.js';
import { settingRecordId } from './setting-record-id.js';
import { SettingsCache, type StoredSetting } from './settings-cache.js';
import { SettingError } from './settings.errors.js';

/** A settings row as the read query returns it. */
type SettingRow = {
  key: string;
  value: unknown;
  updated_at: string;
  updated_by: string | null;
};

/** `settings.updated_at` in UTC with microseconds, the form the api sends and takes back. */
const UPDATED_AT_TEXT = sql.raw(
  `to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
);

/** One change asked for through `SettingsService.write`. */
export interface SettingWrite {
  key: string;
  /** The new value, checked against the entry's schema. */
  value: unknown;
  reason?: string;
  /** The `updatedAt` the caller last saw, null when the key had no row. */
  expectedUpdatedAt: string | null;
  /** The person changing it and the hat the audit entry names. */
  actor: { userId: string; hat: string };
}

/** What a write did: the setting as it now stands, and whether anything was written. */
export interface SettingWriteResult {
  setting: StoredSetting;
  changed: boolean;
}

/** JSON text with object keys sorted, so two equal values always compare equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}

/**
 * The only reader and writer of the `settings` table (spec 0009, AC-2, AC-3), typed by the
 * registry in `@ssdashboard/contracts`. A key with no row reads as its registry default; a row
 * that fails its schema reads as the default too, is flagged `invalid`, and logs one error naming
 * the key, never the value. A read given an executor (a transaction) goes to the database; any
 * other read is served from `SettingsCache` (30 seconds, dropped on `NOTIFY`). It never logs a
 * setting value and never writes outside `write`.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger('Settings');
  /** `key@updatedAt` of each invalid row already logged, so one bad row logs once per process. */
  private readonly loggedInvalid = new Set<string>();

  /**
   * Takes the app database connection and the process cache. The audit writer and the reconcile
   * job producer are needed only by `write`. Nest always injects the audit writer; the producer
   * only in the api (`PlatformApiModule`), so in the worker, which never writes a setting, `write`
   * throws. Tests that only read may construct the service without either.
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(SettingsCache) private readonly cache: SettingsCache = new SettingsCache(),
    @Inject(AuditService) private readonly audit?: AuditService,
    @Optional()
    @Inject(ReconcileModulesProducer)
    private readonly reconcileJobs?: ReconcileModulesProducer,
  ) {}

  /**
   * Reads the given settings, inside the caller's transaction when one is passed. A key whose
   * entry says `onInvalid: 'refuse'` (the inventory lock date) and whose stored row fails its
   * schema throws `SettingError('SettingUnreadable')` instead of reading the default, so the work
   * that relies on it stops (fail closed, security review S1).
   */
  async read<K extends SettingKey>(
    keys: readonly K[],
    executor?: Executor,
  ): Promise<Pick<SettingValues, K>> {
    const result: Record<string, unknown> = {};
    for (const setting of await this.load(keys, executor)) {
      const definition = settingDefinitionOf(setting.key);
      if (setting.invalid && definition?.onInvalid === 'refuse') {
        throw new SettingError(
          'SettingUnreadable',
          `Setting "${setting.key}" holds a value that fails its schema`,
        );
      }
      result[setting.key] = setting.value;
    }
    return result as Pick<SettingValues, K>;
  }

  /** Reads one setting, inside the caller's transaction when one is passed; refuses like `read`. */
  async get<K extends SettingKey>(key: K, executor?: Executor): Promise<SettingValues[K]> {
    const values: Pick<SettingValues, K> = await this.read([key], executor);
    return values[key];
  }

  /**
   * The settings with their row facts (`invalid`, `updatedAt`, `updatedBy`), for the staff read.
   * Through `executor` when given (the staff read passes the database, so it is never stale),
   * else through the cache. Never refuses: an invalid row comes back as the default with
   * `invalid: true`, so a manager can see and fix it. Business code reads with `read` or `get`.
   */
  async load(keys: readonly SettingKey[], executor?: Executor): Promise<StoredSetting[]> {
    if (executor) return this.fetch(keys, executor);
    const found = new Map<string, StoredSetting>();
    const missing: SettingKey[] = [];
    for (const key of keys) {
      const cached = this.cache.get(key);
      if (cached) found.set(key, cached);
      else missing.push(key);
    }
    if (missing.length) {
      const generation = this.cache.generation();
      for (const setting of await this.fetch(missing, this.connection.db)) {
        this.cache.store(setting, generation);
        found.set(setting.key, setting);
      }
    }
    return keys.map((key) => found.get(key) as StoredSetting);
  }

  /**
   * Changes one setting (spec 0009, AC-3). Refuses an unknown key (`SettingUnknown`), a key
   * nobody may change (`SettingLocked`), a value nested deeper than 16 levels or failing the
   * entry's schema (`SettingInvalid`, with the issues), and a missing required reason
   * (`SettingReasonRequired`). In one transaction it locks the row, refuses a stale
   * `expectedUpdatedAt` (`StaleSetting`), checks the rules across settings under one advisory lock
   * per group (`settingWriteIssues`: `SettingInvalid`), and, when
   * the value differs from the one in force, writes the row (`updated_at`, `updated_by`), the
   * `setting.changed` audit entry (before, after, reason; the entry's reason rule as the
   * tightening flag), `NOTIFY ssd_platform_changed`, and the `platform.reconcile_modules` job. An
   * equal value writes nothing and answers `changed: false`. A throw anywhere rolls back all four.
   */
  async write(change: SettingWrite): Promise<SettingWriteResult> {
    const definition = settingDefinitionOf(change.key);
    if (!definition) throw new SettingError('SettingUnknown', 'No such setting');
    if (definition.whoMayChange === 'nobody') {
      throw new SettingError('SettingLocked', 'This setting cannot be changed in the app');
    }
    if (nestsDeeperThan(change.value, SETTING_VALUE_MAX_DEPTH)) {
      throw new SettingError('SettingInvalid', 'The value is not valid for this setting', [
        { path: '', message: `A setting value may nest at most ${SETTING_VALUE_MAX_DEPTH} levels` },
      ]);
    }
    const parsed = definition.schema.safeParse(change.value);
    if (!parsed.success) {
      throw new SettingError(
        'SettingInvalid',
        'The value is not valid for this setting',
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    }
    const reasonRequired = definition.reason === 'required';
    if (reasonRequired && !change.reason?.trim()) {
      throw new SettingError('SettingReasonRequired', 'A reason is required for this change');
    }
    const { audit, reconcileJobs } = this;
    // Only the api provides the producer (PlatformApiModule); the worker never writes a setting.
    if (!audit || !reconcileJobs) throw new Error('SettingsService was built without a writer');

    const key = definition.key as SettingKey;
    const next = parsed.data;
    const correlationId = audit.newCorrelationId();
    const result = await this.connection.db.transaction(async (tx) => {
      if (isCrossChecked(key)) {
        // One lock for the group, so two writes cannot each pass alone and break the rule together.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ssd.settings.languages'))`);
        const others = await this.load(SETTING_WRITE_DEPENDENCIES[key], tx);
        const current = Object.fromEntries(
          others.map((other) => [other.key, other.value]),
        ) as Partial<Pick<SettingValues, 'languages' | 'default_language'>>;
        const issues = settingWriteIssues(key, next, current);
        if (issues.length) {
          throw new SettingError(
            'SettingInvalid',
            'The value breaks a rule of another setting',
            issues,
          );
        }
      }
      const { rows } = await tx.execute<SettingRow & { matches: boolean }>(sql`
        SELECT key, value, ${UPDATED_AT_TEXT} AS updated_at, updated_by,
               coalesce(updated_at = ${change.expectedUpdatedAt}::timestamptz, false) AS matches
        FROM settings WHERE key = ${key} FOR UPDATE`);
      const row = rows[0];
      const stale = row ? !row.matches : change.expectedUpdatedAt !== null;
      if (stale) {
        throw new SettingError('StaleSetting', 'This setting was changed by someone else');
      }
      const current = row ? row.value : definition.default;
      if (canonicalJson(current) === canonicalJson(next)) {
        return { setting: this.decode(definition, row), changed: false };
      }

      const json = JSON.stringify(next);
      const written = row
        ? await tx.execute<SettingRow>(sql`
            UPDATE settings SET value = ${json}::jsonb, updated_at = now(),
                                updated_by = ${change.actor.userId}
            WHERE key = ${key}
            RETURNING key, value, ${UPDATED_AT_TEXT} AS updated_at, updated_by`)
        : await tx.execute<SettingRow>(sql`
            INSERT INTO settings (key, value, updated_by)
            VALUES (${key}, ${json}::jsonb, ${change.actor.userId})
            ON CONFLICT (tenant_id, key) DO NOTHING
            RETURNING key, value, ${UPDATED_AT_TEXT} AS updated_at, updated_by`);
      const saved = written.rows[0];
      // Another write added the row after our read: the caller's view is stale.
      if (!saved)
        throw new SettingError('StaleSetting', 'This setting was changed by someone else');

      await audit.record(tx, {
        actor: { kind: 'person', userId: change.actor.userId, hat: change.actor.hat },
        action: 'setting.changed',
        record: { type: 'setting', id: settingRecordId(key), label: key },
        before: { value: current as JsonValue },
        after: { value: next as JsonValue },
        ...(change.reason !== undefined && { reason: change.reason }),
        ...(reasonRequired && { reasonRequired: true as const }),
        correlationId,
      });
      await tx.execute(sql`SELECT pg_notify(${PLATFORM_CHANGED_CHANNEL}, ${key})`);
      await reconcileJobs.enqueueIn(tx);
      return { setting: this.decode(definition, saved), changed: true };
    });
    // This process need not wait for its own notification.
    if (result.changed) this.cache.drop(key);
    return result;
  }

  private async fetch(keys: readonly SettingKey[], executor: Executor): Promise<StoredSetting[]> {
    const { rows } = await executor.execute<SettingRow>(sql`
      SELECT key, value, ${UPDATED_AT_TEXT} AS updated_at, updated_by
      FROM settings WHERE key = ANY(${pgArray(keys)}::text[])`);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return keys.map((key) =>
      this.decode(settingDefinitionOf(key) as SettingDefinition, byKey.get(key)),
    );
  }

  /** The setting a row (or its absence) gives, logging an invalid row once without its value. */
  private decode(definition: SettingDefinition, row: SettingRow | undefined): StoredSetting {
    if (!row) {
      return {
        key: definition.key,
        value: definition.default,
        raw: undefined,
        hasRow: false,
        invalid: false,
        updatedAt: null,
        updatedBy: null,
      };
    }
    const parsed = definition.schema.safeParse(row.value);
    if (!parsed.success) {
      const seen = `${definition.key}@${row.updated_at}`;
      if (!this.loggedInvalid.has(seen)) {
        this.loggedInvalid.add(seen);
        // Names the key and what happens, never the value (review N1).
        this.logger.error(
          definition.onInvalid === 'refuse'
            ? `Setting "${definition.key}" holds a value that fails its schema; the work that relies on it is refused until it is set again`
            : `Setting "${definition.key}" holds a value that fails its schema; using its default`,
        );
      }
    }
    return {
      key: definition.key,
      value: parsed.success ? parsed.data : definition.default,
      raw: row.value,
      hasRow: true,
      invalid: !parsed.success,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }
}

/** The calendar date of an instant in a time zone, as `YYYY-MM-DD`; throws for an unknown zone or an invalid instant. */
export function localDate(at: Date, timeZone: string): string {
  const day = createFormatter({ language: 'en', timezone: timeZone }).calendarDate(at);
  if (day === null) throw new RangeError(`No calendar date for time zone "${timeZone}"`);
  return day;
}
