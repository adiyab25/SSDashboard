import type { TaskListRow } from '@ssdashboard/contracts';

/** The id of the task every tasks spec reads. */
export const TASK_ID = '60000000-0000-4000-8000-000000000001';

/**
 * A failed Shopify write back on order `ESS/#1001`, open and not overdue, that only the system
 * closes (no allowed outcomes), for the tasks specs; `overrides` change any field. Test data only:
 * never imported by app code.
 */
export const taskListRowOf = (overrides: Partial<TaskListRow> = {}): TaskListRow => ({
  id: TASK_ID,
  type: 'sync.write_back_failed',
  linkedType: 'order',
  linkedId: '00000000-0000-4000-8000-000000000001',
  subjectKey: 'shopify.order_edit:HTTP_500',
  ownerUserId: null,
  ownerHat: 'operations',
  ownerName: null,
  heldBy: null,
  dueAt: '2026-11-12T10:00:00.000000Z',
  overdue: false,
  status: 'open',
  outcomeCode: null,
  createdByType: 'system_job',
  createdAt: '2026-11-12T09:00:00.000000Z',
  updatedAt: '2026-11-12T09:30:00.123456Z',
  closedAt: null,
  link: {
    kind: 'order',
    id: '00000000-0000-4000-8000-000000000001',
    path: '/orders/00000000-0000-4000-8000-000000000001',
    label: { kind: 'order', number: '#1001', storeCode: 'ESS' },
  },
  allowedOutcomes: [],
  ...overrides,
});

/** The same row, but one a person may close with either outcome the registry lists for it. */
export const closableTaskOf = (overrides: Partial<TaskListRow> = {}): TaskListRow =>
  taskListRowOf({ allowedOutcomes: ['synced', 'resolved'], ...overrides });
