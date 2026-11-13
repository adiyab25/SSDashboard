import {
  TaskListResponse,
  TaskListRow,
  TaskSummary,
  type CloseTaskBody,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** Query keys of the tasks screens and the shell badges. */
export const taskKeys = {
  /** Every tasks query, for a refresh after a write. */
  all: ['tasks'] as const,
  /** My work, as a person reads it. */
  mine: ['tasks', 'list', 'mine'] as const,
  /** The counts the navigation shows. */
  summary: ['tasks', 'summary'] as const,
};

/** `GET /api/tasks?view=mine` (`tasks.work`): one keyset page of the caller's open tasks, in due order. */
export function listMyTasks(cursor: string | undefined, signal?: AbortSignal) {
  const params = new URLSearchParams({ view: 'mine' });
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/tasks?${params}`, TaskListResponse, { signal });
}

/** `GET /api/tasks/summary` (`tasks.work`): open, overdue, and due today counts, and `unsyncedEdits` for `orders.confirm` holders. */
export function getTaskSummary(signal?: AbortSignal) {
  return apiRequest('GET', '/api/tasks/summary', TaskSummary, { signal });
}

/** `POST /api/tasks/:id/close` (`tasks.work`): closes one task with an outcome a person may set and answers it as My work shows it. */
export function closeTask(id: string, body: CloseTaskBody) {
  return apiRequest('POST', `/api/tasks/${encodeURIComponent(id)}/close`, TaskListRow, { body });
}
