import { ConnectionFreshnessResponse } from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/**
 * The query key of the freshness line. It sits under `['connections']`, so connecting a store
 * (which invalidates every connections query) refreshes the line at once.
 */
export const connectionFreshnessKey = ['connections', 'freshness'] as const;

/** `GET /api/connections/freshness` (`orders.view`, spec 0015 AC-18): one entry per active connection. */
export function getConnectionFreshness(signal?: AbortSignal) {
  return apiRequest('GET', '/api/connections/freshness', ConnectionFreshnessResponse, { signal });
}
