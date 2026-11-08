import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
  UnprocessableEntityException,
  type HttpException,
} from '@nestjs/common';
import {
  CostRulesQuery,
  RecordCostRuleBody,
  type CostRuleRow,
  type CostRulesResponse,
} from '@ssdashboard/contracts';
import { type DatabaseConnection } from '@ssdashboard/db';
import { auditHttpError } from '../audit/audit-http.js';
import { DATABASE } from '../database/database.module.js';
import { StaffDirectory } from '../identity/staff/staff-directory.js';
import type { Access } from './access/access.js';
import { CurrentAccess } from './access/current-access.decorator.js';
import { Permission } from './access/permission.decorator.js';
import { Audience } from './audience/audience.decorator.js';
import {
  CostRuleError,
  CostRulesService,
  isLockDateUnreadable,
  type RecordedCostRule,
} from './cost-rules.service.js';
import { InvalidCursorError } from './keyset-cursor.js';
import { RequiresModule } from './modules/requires-module.decorator.js';
import { SettingsService } from './settings/settings.service.js';
import { ZodBodyPipe } from './zod-body.pipe.js';
import { ZodQueryPipe } from './zod-query.pipe.js';

/**
 * The api edge mapping of the cost rule errors (spec 0009, AC-23): 422 `SETTING_INVALID`, 422
 * `REASON_REQUIRED`, 409 `COST_RULE_IN_LOCKED_PERIOD` with `months`, 409 `LOCK_DATE_UNREADABLE`,
 * 400 `INVALID_QUERY` for a cursor this endpoint never issued. Undefined for anything else.
 */
export function costRulesHttpError(error: unknown): HttpException | undefined {
  if (error instanceof InvalidCursorError) {
    return new BadRequestException({ code: 'INVALID_QUERY', message: error.message });
  }
  if (isLockDateUnreadable(error)) {
    return new ConflictException({
      code: 'LOCK_DATE_UNREADABLE',
      message: 'The inventory lock date holds a value that is not valid; set it again first',
    });
  }
  if (!(error instanceof CostRuleError)) return undefined;
  switch (error.kind) {
    case 'CostRuleInvalid':
      return new UnprocessableEntityException({
        code: 'SETTING_INVALID',
        message: error.message,
        issues: [{ path: 'value', message: error.message }],
      });
    case 'CostRuleReasonRequired':
      return new UnprocessableEntityException({ code: 'REASON_REQUIRED', message: error.message });
    case 'InLockedPeriod':
      return new ConflictException({
        code: 'COST_RULE_IN_LOCKED_PERIOD',
        message: error.message,
        months: error.months,
      });
  }
}

/**
 * The per order cost rules for the people who see cost (spec 0009, AC-23, D15): a holder of
 * `cost.view` reads the rule in force today for every kind, the history, and the lock date (so the
 * page can say nothing is locked yet); a holder of both `settings.manage` and `cost.view` records
 * a new rule with a reason. Staff only. Holds no rule itself; `CostRulesService` does.
 */
@Audience('staff')
@RequiresModule('platform')
@Controller('platform/cost-rules')
export class CostRulesController {
  /** Takes the cost rules service, settings (the lock date), the database, and staff names. */
  constructor(
    @Inject(CostRulesService) private readonly rules: CostRulesService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(StaffDirectory) private readonly staff: StaffDirectory,
  ) {}

  /**
   * The rule in force today for every kind, one page of the history (newest first), and the
   * `inventory_lock_date` setting with whether it is unreadable. 400 `INVALID_QUERY` for a bad page
   * size or cursor.
   */
  @Get()
  @Permission('cost.view')
  async list(
    @Query(new ZodQueryPipe(CostRulesQuery)) query: CostRulesQuery,
  ): Promise<CostRulesResponse> {
    try {
      const db = this.connection.db;
      const today = await this.rules.today(db);
      const current = await this.rules.current(today, db);
      const history = await this.rules.history(
        { limit: query.limit, ...(query.cursor !== undefined && { cursor: query.cursor }) },
        db,
      );
      const [lock] = await this.settings.load(['inventory_lock_date'], db);
      const rows = [
        ...history.items,
        ...current.flatMap((entry) => (entry.row ? [entry.row] : [])),
      ];
      const names = await this.staff.namesByIds(
        rows.flatMap((row) => (row.recordedBy ? [row.recordedBy] : [])),
      );
      const view = (row: RecordedCostRule): CostRuleRow => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        value: row.value,
        effectiveFrom: row.effectiveFrom,
        recordedAt: row.recordedAt,
        recordedBy: row.recordedBy
          ? { id: row.recordedBy, name: names.get(row.recordedBy) ?? null }
          : null,
      });
      return {
        today,
        current: current.map((entry) => ({
          kind: entry.kind,
          rule: entry.rule,
          row: entry.row ? view(entry.row) : null,
        })),
        history: { items: history.items.map(view), nextCursor: history.nextCursor },
        lockDate: lock?.invalid ? null : ((lock?.value as string | null | undefined) ?? null),
        lockDateInvalid: lock?.invalid === true,
      };
    } catch (error) {
      throw costRulesHttpError(error) ?? error;
    }
  }

  /**
   * Records a new rule (AC-23): 422 `SETTING_INVALID`, 422 `REASON_REQUIRED`, 409
   * `COST_RULE_IN_LOCKED_PERIOD` with `months` (send again with `inLockedPeriod: true` to record
   * it in the locked period on purpose), 409 `LOCK_DATE_UNREADABLE`. Answers the new row.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Permission('settings.manage', 'cost.view')
  async record(
    @Body(new ZodBodyPipe(RecordCostRuleBody, { code: 'SETTING_INVALID' }))
    body: RecordCostRuleBody,
    @CurrentAccess() access: Access,
  ): Promise<CostRuleRow> {
    try {
      const row = await this.rules.record({
        kind: body.kind,
        status: body.status,
        ...(body.value !== undefined && { value: body.value }),
        effectiveFrom: body.effectiveFrom,
        ...(body.reason !== undefined && { reason: body.reason }),
        ...(body.inLockedPeriod !== undefined && { inLockedPeriod: body.inLockedPeriod }),
        actor: { userId: access.userId, hat: access.actingHat('settings.manage') },
      });
      const names = await this.staff.namesByIds([access.userId]);
      return {
        ...row,
        recordedBy: row.recordedBy
          ? { id: row.recordedBy, name: names.get(row.recordedBy) ?? null }
          : null,
      };
    } catch (error) {
      throw costRulesHttpError(error) ?? auditHttpError(error) ?? error;
    }
  }
}
