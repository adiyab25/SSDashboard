import type { InvalidateQueryFilters, QueryClient } from '@tanstack/react-query';

/**
 * After a write, makes every query matching `filters` read the api again, including one whose
 * first fetch is still on its way.
 *
 * Why: `invalidateQueries` alone does not refetch a query whose first fetch is in flight. TanStack
 * cancels a running fetch only for a query that already has data; otherwise the invalidation joins
 * the running request. When that request left before the write committed (a search typed just
 * before Save), the screen keeps the answer read before the write. Cancelling first drops such a
 * fetch (it reverts to its state before the fetch), so the invalidation asks again.
 *
 * It never cancels anything outside `filters`, and like `invalidateQueries` it fetches only the
 * queries someone is watching; the others are marked stale for their next use.
 */
export async function refetchAfterWrite(
  queryClient: QueryClient,
  filters: InvalidateQueryFilters,
): Promise<void> {
  await queryClient.cancelQueries(filters);
  await queryClient.invalidateQueries(filters);
}
