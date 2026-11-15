import type { MessageKey } from '@ssdashboard/i18n';
import type { InternalHat, Permission } from '../access.js';
import type { TaskLinkedType } from './task-enums.js';

/**
 * When a task of a type is due if its opener passes no due time (spec 0016, AC-6). Milestone 1
 * evaluates `now` at the platform clock; fitting the result to the brand's working hours arrives
 * with milestone 2.
 */
export type TaskDueRule =
  | { readonly kind: 'none' }
  /** Now, or the next opening when outside working hours. */
  | { readonly kind: 'now' }
  /** This many working minutes from now (from the next opening when outside working hours). */
  | { readonly kind: 'after_minutes'; readonly minutes: number }
  /** The next occurrence of this wall clock time (HH:MM) inside working hours, strictly after now. */
  | { readonly kind: 'next_local_time'; readonly time: string }
  /** The opener must pass a due time (cases, callbacks). */
  | { readonly kind: 'required' };

/**
 * One task type (spec 0016, AC-1). The code is `<area>.<name>`, `ReasonCode` shaped. A brand can
 * never define one: adding a type is a code change to `TASK_TYPES` (AC-15).
 */
export interface TaskTypeDefinition {
  /** The api module whose work it is (a `MODULE_REGISTRY` key). */
  readonly module: string;
  /** The record kinds it may be opened on. */
  readonly linkedTypes: readonly TaskLinkedType[];
  /** The queue that holds it when nobody is assigned. */
  readonly defaultHat: InternalHat;
  /** Needed to see it, to be assigned it, and to close it. */
  readonly requiredPermission: Permission;
  /** The due time when the opener passes none. */
  readonly due: TaskDueRule;
  /** Every outcome code it may close with, `ReasonCode` shaped. */
  readonly outcomes: readonly string[];
  /** Outcomes only the system may set (for example `synced`). */
  readonly systemOutcomes?: readonly string[];
  /** Outcomes a person may set only with a note (for example `refund_needed`). */
  readonly noteRequiredOutcomes?: readonly string[];
  /** `system`: a person can never close it by hand. */
  readonly closedBy: 'person' | 'system' | 'both';
  /** False: the snooze route refuses it (the owning module may still reschedule). Default true. */
  readonly snoozable?: boolean;
  /** True when a person may open it through `POST /api/tasks`. */
  readonly openableByPerson: boolean;
  /** True when a dedupe key opens at most one task ever, not one at a time. */
  readonly once?: true;
  /** True when the tasks module cancels it as the order moves to `cancelled`. */
  readonly cancelWhenOrderEnds?: true;
  /** The catalog key of its label, `tasks.types.<code>`. */
  readonly label: MessageKey;
  /** The catalog key of each outcome's label, `tasks.outcomes.<code>`. */
  readonly outcomeLabels: Readonly<Record<string, MessageKey>>;
}

/**
 * Every task type that has code to open it (spec 0016, *The type registry at the start*). A row
 * lands in the same change as the code that opens it, with its label keys in both catalogs.
 * Milestone 1 has the failed Shopify write back only; the others arrive with their milestones.
 */
export const TASK_TYPES = {
  'sync.write_back_failed': {
    module: 'tasks',
    linkedTypes: ['order', 'customer', 'variant', 'exchange', 'refund', 'connection'],
    defaultHat: 'operations',
    requiredPermission: 'orders.confirm',
    due: { kind: 'now' },
    outcomes: ['synced', 'resolved'],
    systemOutcomes: ['synced', 'resolved'],
    closedBy: 'system',
    snoozable: false,
    openableByPerson: false,
    label: 'tasks.types.sync.write_back_failed',
    outcomeLabels: {
      synced: 'tasks.outcomes.synced',
      resolved: 'tasks.outcomes.resolved',
    },
  },
} as const satisfies Readonly<Record<string, TaskTypeDefinition>>;

/** A registered task type code. */
export type TaskTypeCode = keyof typeof TASK_TYPES;

/** The definition of a registered code, or undefined for a code the registry does not hold. */
export function taskTypeOf(code: string): TaskTypeDefinition | undefined {
  return Object.hasOwn(TASK_TYPES, code) ? TASK_TYPES[code as TaskTypeCode] : undefined;
}
