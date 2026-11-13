'use client';

import { useQuery } from '@tanstack/react-query';
import { useAccess } from '@/access/use-access';
import { useModuleStates } from '@/shell/use-module-states';
import { getTaskSummary, taskKeys } from './tasks-api';

/** Milliseconds between two reads: the spec's "once a minute" (spec 0016, AC-7). */
const MINUTE_MS = 60_000;

/**
 * The counts the navigation shows (spec 0016, AC-7): reads `GET /api/tasks/summary` once a minute
 * while the tab is visible (TanStack Query skips the timer in a hidden tab and reads again on
 * return), and only for a person with `tasks.work` while the `tasks` module is not off, so everyone else makes no call and gets no
 * summary. `summary` is undefined while loading, when the call fails, and for a person without
 * `tasks.work`: the shell shows a nudge, never a blocker. `summary.unsyncedEdits` is absent unless
 * the person holds `orders.confirm`.
 */
export function useTaskSummary() {
  const access = useAccess();
  const { stateOf } = useModuleStates();
  const tasksState = stateOf('tasks')?.state;
  // Not while the module states are unknown or the module is off: the api would answer 404 `MODULE_OFF`.
  const enabled = access.can('tasks.work') && tasksState !== undefined && tasksState !== 'off';
  const query = useQuery({
    queryKey: taskKeys.summary,
    queryFn: ({ signal }) => getTaskSummary(signal),
    enabled,
    retry: false,
    refetchInterval: MINUTE_MS,
    refetchIntervalInBackground: false,
    staleTime: MINUTE_MS,
  });
  return { summary: enabled ? query.data : undefined };
}
