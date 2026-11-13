import type { TaskDueRule } from '@ssdashboard/contracts';
import { DueRequired, DueRuleUnsupported } from './task-errors.js';

/**
 * The due time a registry rule gives when the opener passes none (spec 0016 AC-6), at `now` from
 * `PlatformClock`. `null` means no due time. Pure.
 *
 * Milestone 1 reads `now` as the clock's now. Fitting it to the brand's working hours
 * (`operations.working_hours`, the next opening, working minutes) arrives in milestone 2; until
 * then a rule that needs the hours (`after_minutes`, `next_local_time`) is refused with
 * `DueRuleUnsupported` instead of guessing, and no registered type uses one. Throws `DueRequired`
 * for the `required` rule.
 */
export function dueFromRule(rule: TaskDueRule, now: Date): Date | null {
  switch (rule.kind) {
    case 'none':
      return null;
    case 'now':
      return now;
    case 'required':
      throw new DueRequired();
    case 'after_minutes':
    case 'next_local_time':
      throw new DueRuleUnsupported();
    default: {
      const unreachable: never = rule;
      return unreachable;
    }
  }
}
