'use client';

import type { ModuleStateView } from '@ssdashboard/contracts';
import { useQuery } from '@tanstack/react-query';
import { findModuleState, getModuleStates, moduleKeys } from './module-states-api';

/** Milliseconds between two reads while the tab stays open: the spec's "at most every 60 seconds". */
const REFRESH_MS = 60_000;

/**
 * Reads `GET /api/platform/modules` once for the whole shell (spec 0009, AC-9): again on window
 * focus and every 60 seconds, and at once when an api answer of 404 `MODULE_OFF` or 409
 * `MODULE_LIMITED` invalidates `moduleKeys.all` (see `onModuleRefusal` in `Providers`). While the answer
 * is not in, or when the call failed, `stateOf` is null for every key and the shell shows
 * everything: it only hides, the api still answers 404.
 */
export function useModuleStates() {
  const query = useQuery({
    queryKey: moduleKeys.all,
    queryFn: ({ signal }) => getModuleStates(signal),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: 'always',
  });
  const answer = query.data;
  return {
    answer,
    /** True once an answer is in. */
    ready: answer !== undefined,
    stateOf: (key: string): ModuleStateView | null =>
      answer ? (findModuleState(answer, key) ?? null) : null,
  };
}
