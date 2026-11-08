import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  OrderCostRuleKind,
  PERCENT_COST_RULE_KINDS,
  type CostRule,
  type OrderCostRuleStatus,
} from '@ssdashboard/contracts';
import { sql, type DatabaseConnection } from '@ssdashboard/db';
import { AuditService } from '../audit/audit.service.js';
import { DATABASE } from '../database/database.module.js';
import type { Executor } from '../database/sql.js';
import {
  assertOperatingDay,
  selectCostRule,
  winningCostRule,
  type CostRuleCandidate,
} from './cost-rule-selection.js';
import { decodeTimeIdKeyset, encodeKeyset } from './keyset-cursor.js';
import { SettingError } from './settings/settings.errors.js';
import { SettingsService } from './settings/settings.service.js';

interface CostRuleRow extends Record<string, unknown> {
  id: string;
  status: OrderCostRuleStatus;
  value: string | null;
  effective_from: string;
  recorded_at: string;
}

/** One stored rule row as the history and the record answer carry it. */
export interface RecordedCostRule {
  id: string;
  kind: OrderCostRuleKind;
  status: OrderCostRuleStatus;
  /** `numeric(14,4)` text; null exactly when `status` is `not_set`. */
  value: string | null;
  /** The operating day it applies from, `YYYY-MM-DD`. */
  effectiveFrom: string;
  /** When the database recorded it, UTC with microseconds (`...123456Z`). */
  recordedAt: string;
  /** Who recorded it; null for the rows `migrate` seeds. */
  recordedBy: string | null;
}

/** One rule to record through `CostRulesService.record` (spec 0009, AC-23). */
export interface CostRuleRecording {
  kind: OrderCostRuleKind;
  status: OrderCostRuleStatus;
  /** Exactly when `status` is `set`: a percent from 0 to 100, or EGP for packaging. */
  value?: string;
  /** The operating day it applies from, `YYYY-MM-DD`. */
  effectiveFrom: string;
  /** The manager's reason; required (the audit codes require one). */
  reason?: string;
  /** True to record a rule from a day on or before the inventory lock date on purpose (D14). */
  inLockedPeriod?: boolean;
  /** The person recording it and the hat the audit entry names. */
  actor: { userId: string; hat: string };
}

/** The cost rule rules a caller can break. */
export type CostRuleErrorKind = 'CostRuleInvalid' | 'CostRuleReasonRequired' | 'InLockedPeriod';

/**
 * A cost rule refused (spec 0009, AC-23): `CostRuleInvalid` (a value missing for `set`, given for
 * `not_set`, or a percent above 100), `CostRuleReasonRequired`, or `InLockedPeriod` with the
 * locked months (`YYYY-MM`) whose margins the rule would change. Carries no value and no reason
 * text, because error text reaches logs.
 */
export class CostRuleError extends Error {
  /** Takes the stable kind, a message safe to log, and the locked months for `InLockedPeriod`. */
  constructor(
    readonly kind: CostRuleErrorKind,
    message: string,
    readonly months: readonly string[] = [],
  ) {
    super(message);
    this.name = kind;
  }
}

/** `recorded_at` in UTC with microseconds, the form the api sends and the cursor carries. */
const RECORDED_AT_TEXT = sql.raw(
  `to_char(r.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
);

/**
 * The per order cost rules (COD fee percent, gateway fee percent, packaging per order,
 * unrestockable returned to origin percent) in `order_cost_rules` (spec 0002, catalog child,
 * AC-32; spec 0009, AC-23): `ruleFor` reads the rule in force on a day, `record` adds a rule (the
 * only writer; the rows are append only, seeded `not_set` by `migrate`), `history` pages every
 * row. Never answers 0 for a rule that is not set, never updates or deletes a row, and never
 * moves the inventory lock date: a rule inside the locked period is recorded only with the
 * explicit override and its own audit code.
 */
@Injectable()
export class CostRulesService {
  /**
   * Takes the app database connection. The settings (the lock date) and the audit writer are
   * needed only by `record`; Nest always injects them, and tests that only read may leave them
   * out.
   */
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Optional() @Inject(SettingsService) private readonly settings?: SettingsService,
    @Optional() @Inject(AuditService) private readonly audit?: AuditService,
  ) {}

  /**
   * The rule of `kind` in force on `onDay` (`YYYY-MM-DD`, an operating day): status `set` with
   * the value as `numeric(14,4)` text (a percent from 0 to 100, or EGP for `packaging_per_order`),
   * or status `not_set` before the first row or when the winning row is `not_set`, never 0.
   * Selection is `selectCostRule`. A day that is not a `YYYY-MM-DD` calendar date throws
   * `InvalidOperatingDay` before any query runs.
   */
  async ruleFor(
    kind: OrderCostRuleKind,
    onDay: string,
    executor: Executor = this.connection.db,
  ): Promise<CostRule> {
    return selectCostRule(await this.candidates(kind, onDay, executor), onDay);
  }

  /**
   * Every kind with the rule in force on `onDay` and the row that decided it (null before any row
   * or when no row applies yet), in kind order.
   */
  async current(
    onDay: string,
    executor: Executor = this.connection.db,
  ): Promise<{ kind: OrderCostRuleKind; rule: CostRule; row: RecordedCostRule | null }[]> {
    const result = [];
    for (const kind of OrderCostRuleKind.options) {
      const candidates = await this.candidates(kind, onDay, executor);
      const rule = selectCostRule(candidates, onDay);
      const winner = winningCostRule(candidates, onDay);
      result.push({ kind, rule, row: winner ? await this.row(winner.id, executor) : null });
    }
    return result;
  }

  /** The operating day today (the database clock, `timezone`, and the cutoff hour), `YYYY-MM-DD`. */
  async today(executor: Executor = this.connection.db): Promise<string> {
    const { rows } = await executor.execute<{ day: string }>(
      sql`SELECT to_char(ssd_operating_day(now()), 'YYYY-MM-DD') AS day`,
    );
    return rows[0]?.day as string;
  }

  /**
   * One page of every rule row, newest recorded first, keyed by (`recorded_at`, `id`); the cursor
   * is the last row's key (`InvalidCursorError` for one this endpoint never issued).
   */
  async history(
    page: { limit: number; cursor?: string },
    executor: Executor = this.connection.db,
  ): Promise<{ items: RecordedCostRule[]; nextCursor: string | null }> {
    const after = page.cursor === undefined ? undefined : decodeTimeIdKeyset(page.cursor);
    const { rows } = await executor.execute<RuleRow>(sql`
      SELECT r.id, r.kind, r.status, r.value::text AS value,
             to_char(r.effective_from, 'YYYY-MM-DD') AS effective_from,
             ${RECORDED_AT_TEXT} AS recorded_at, r.recorded_by
      FROM order_cost_rules r
      ${after ? sql`WHERE (r.recorded_at, r.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
      ORDER BY r.recorded_at DESC, r.id DESC
      LIMIT ${page.limit + 1}`);
    const items = rows.slice(0, page.limit).map(toRecorded);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > page.limit && last ? encodeKeyset([last.recordedAt, last.id]) : null,
    };
  }

  /**
   * Records a new rule (spec 0009, AC-23): one append only row and its audit entry in one
   * transaction. Refuses a value missing for `set`, given for `not_set`, or a percent above 100
   * (`CostRuleInvalid`), a blank reason (`CostRuleReasonRequired`), and an `effectiveFrom` on or
   * before the `inventory_lock_date` setting (`InLockedPeriod`, with the months the rule would
   * change) unless `inLockedPeriod` is true, which records it as
   * `cost_rule.recorded_in_locked_period` instead of `cost_rule.recorded`. The lock date is read
   * in the transaction and fails closed (`SettingError` `SettingUnreadable` for a corrupt row).
   * Rules of one kind are recorded one at a time, so the rule in force before (the audit
   * `before`) is the one the new row supersedes.
   */
  async record(input: CostRuleRecording): Promise<RecordedCostRule> {
    assertOperatingDay(input.effectiveFrom);
    if ((input.status === 'set') !== (input.value !== undefined)) {
      throw new CostRuleError('CostRuleInvalid', 'A value is given exactly when the rule is set');
    }
    if (
      input.value !== undefined &&
      PERCENT_COST_RULE_KINDS.includes(input.kind) &&
      Number(input.value) > 100
    ) {
      throw new CostRuleError('CostRuleInvalid', 'A percent is from 0 to 100');
    }
    if (!input.reason?.trim()) {
      throw new CostRuleError('CostRuleReasonRequired', 'A reason is required for a cost rule');
    }
    const { settings, audit } = this;
    if (!settings || !audit) throw new Error('CostRulesService was built without a writer');
    const reason = input.reason;

    return this.connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`ssd.cost_rules.${input.kind}`}))`,
      );
      // FOR SHARE: a lock date write waits for this rule's commit, so the check holds (a later
      // lock date that would cover this day is written only after the rule is recorded).
      const lockDate = await settings.get('inventory_lock_date', tx, { forShare: true });
      const locked = lockDate !== null && input.effectiveFrom <= lockDate;
      if (locked && input.inLockedPeriod !== true) {
        throw new CostRuleError(
          'InLockedPeriod',
          'The rule starts on or before the inventory lock date',
          await this.lockedMonths(input.kind, input.effectiveFrom, lockDate, tx),
        );
      }
      const before = await this.ruleFor(input.kind, input.effectiveFrom, tx);
      const { rows } = await tx.execute<{ id: string }>(sql`
        INSERT INTO order_cost_rules (kind, status, value, effective_from, recorded_by)
        VALUES (${input.kind}::order_cost_rule_kind, ${input.status}::order_cost_rule_status,
                ${input.value ?? null}::numeric, ${input.effectiveFrom}::date, ${input.actor.userId})
        RETURNING id`);
      const id = rows[0]?.id as string;
      const recorded = (await this.row(id, tx)) as RecordedCostRule;
      await audit.record(tx, {
        actor: { kind: 'person', userId: input.actor.userId, hat: input.actor.hat },
        action: locked ? 'cost_rule.recorded_in_locked_period' : 'cost_rule.recorded',
        record: { type: 'order_cost_rule', id, label: input.kind },
        before: {
          status: before.status,
          value: before.status === 'set' ? before.value : null,
        },
        after: {
          status: recorded.status,
          value: recorded.value,
          effectiveFrom: recorded.effectiveFrom,
          ...(locked && { lockDate }),
        },
        reason,
        correlationId: audit.newCorrelationId(),
      });
      return recorded;
    });
  }

  /**
   * The months, `YYYY-MM`, oldest first, whose margins a rule of `kind` from `from` would change
   * inside the locked period: from its day until the lock date, or until the day before the next
   * later rule of the kind takes over, whichever comes first.
   */
  private async lockedMonths(
    kind: OrderCostRuleKind,
    from: string,
    lockDate: string,
    executor: Executor,
  ): Promise<string[]> {
    const { rows } = await executor.execute<{ month: string }>(sql`
      WITH bounds AS (
        SELECT least(
          ${lockDate}::date,
          coalesce(
            (SELECT min(effective_from) - 1 FROM order_cost_rules
             WHERE kind = ${kind}::order_cost_rule_kind AND effective_from > ${from}::date),
            ${lockDate}::date)) AS last_day)
      SELECT to_char(m, 'YYYY-MM') AS month
      FROM bounds,
           generate_series(date_trunc('month', ${from}::date),
                           date_trunc('month', bounds.last_day), interval '1 month') AS m
      ORDER BY m`);
    return rows.map((row) => row.month);
  }

  private async candidates(
    kind: OrderCostRuleKind,
    onDay: string,
    executor: Executor,
  ): Promise<CostRuleCandidate[]> {
    assertOperatingDay(onDay);
    // Only the rows on the latest applicable day come back; the rule picks among them.
    const { rows } = await executor.execute<CostRuleRow>(sql`
      WITH candidates AS (
        SELECT id, status, value, effective_from, recorded_at
        FROM order_cost_rules
        WHERE kind = ${kind}::order_cost_rule_kind AND effective_from <= ${onDay}::date)
      SELECT id, status, value,
             to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
             to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS recorded_at
      FROM candidates
      WHERE effective_from = (SELECT max(effective_from) FROM candidates)
      ORDER BY id`);
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      value: row.value,
      effectiveFrom: row.effective_from,
      recordedAt: row.recorded_at,
    }));
  }

  private async row(id: string, executor: Executor): Promise<RecordedCostRule | null> {
    const { rows } = await executor.execute<RuleRow>(sql`
      SELECT r.id, r.kind, r.status, r.value::text AS value,
             to_char(r.effective_from, 'YYYY-MM-DD') AS effective_from,
             ${RECORDED_AT_TEXT} AS recorded_at, r.recorded_by
      FROM order_cost_rules r WHERE r.id = ${id}`);
    return rows[0] ? toRecorded(rows[0]) : null;
  }
}

/** A rule row as the history and the record answer read it. */
interface RuleRow extends Record<string, unknown> {
  id: string;
  kind: OrderCostRuleKind;
  status: OrderCostRuleStatus;
  value: string | null;
  effective_from: string;
  recorded_at: string;
  recorded_by: string | null;
}

function toRecorded(row: RuleRow): RecordedCostRule {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    value: row.value,
    effectiveFrom: row.effective_from,
    recordedAt: row.recorded_at,
    recordedBy: row.recorded_by,
  };
}

/** Whether an error is the fail closed read of a corrupt lock date. */
export function isLockDateUnreadable(error: unknown): boolean {
  return error instanceof SettingError && error.kind === 'SettingUnreadable';
}
