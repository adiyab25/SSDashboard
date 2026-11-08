import {
  ConnectShopifyResponse,
  ConnectionListResponse,
  type ConnectShopifyBody,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** Query keys, so a connect invalidates exactly the list. */
export const connectionKeys = {
  /** Every connections query. */
  all: ['connections'] as const,
  /** The list, one cursor chain. */
  list: ['connections', 'list'] as const,
};

/** `GET /api/connections` (`settings.manage`): one page of connections, newest first, 50 a page. */
export function listConnections(cursor: string | undefined, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/connections?${params}`, ConnectionListResponse, { signal });
}

/**
 * `POST /api/connections/shopify` (`settings.manage`, spec 0015 AC-1): connects a store. The body
 * carries the client secret the owner typed; the answer never does, and nothing here keeps it.
 */
export function connectShopify(body: ConnectShopifyBody) {
  return apiRequest('POST', '/api/connections/shopify', ConnectShopifyResponse, { body });
}
