import { Injectable } from '@nestjs/common';
import { suggestedRiskFlag, type CustomerRiskSignal } from '@ssdashboard/contracts';
import type { Executor } from '../../database/sql.js';
import { OrderQueries } from '../../orders/reading/order-query.service.js';
import { localDate, SettingsService } from '../../platform/settings/settings.service.js';

const DAY_MS = 86_400_000;

/** The calendar day `days` before `day` (`YYYY-MM-DD`), counted on the calendar, never in hours. */
export function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The returner signal of spec 0014 AC-13 and the order count of the merge compare (AC-7), read
 * only through the orders module's `OrderQueries.countsForCustomers`, never an orders table.
 * Computed on each call, never stored; it writes nothing.
 */
@Injectable()
export class CustomerRiskSignals {
  /** Takes the orders reads and the settings. */
  constructor(
    private readonly orders: OrderQueries,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The signal of a customer's id set: refusals and returns since the operating day `windowDays`
   * before today in the install time zone (`timezone` through `localDate`), and the suggested kind
   * by `suggestedRiskFlag` against the thresholds of `customer_risk_signal` (none when `flagged`).
   * The settings are read through `executor` so a changed threshold applies on the next read.
   */
  async signalOf(
    ids: readonly string[],
    flagged: boolean,
    executor: Executor,
    now: Date = new Date(),
  ): Promise<CustomerRiskSignal> {
    const { customer_risk_signal: rule, timezone } = await this.settings.read(
      ['customer_risk_signal', 'timezone'],
      executor,
    );
    const sinceDay = daysBefore(localDate(now, timezone), rule.windowDays);
    const counts = await this.orders.countsForCustomers(ids, { sinceDay }, executor);
    const refusals = counts.refused;
    const returns = counts.returned;
    return {
      refusals,
      returns,
      windowDays: rule.windowDays,
      suggestedKind: suggestedRiskFlag({ refusals, returns }, rule, flagged),
    };
  }

  /** Every order of the id set, all time and any type (`countsForCustomers` with no day). */
  async orderCount(ids: readonly string[], executor: Executor): Promise<number> {
    return (await this.orders.countsForCustomers(ids, { sinceDay: null }, executor)).orders;
  }
}
