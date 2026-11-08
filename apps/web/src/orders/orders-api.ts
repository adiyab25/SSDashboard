import {
  CreatedOrder,
  OrderDetail,
  OrderFilterOptions,
  OrderListResponse,
  OrderOptions,
  type CreateGiftedOrderBody,
  type CancelOrderBody,
  type CreateManualOrderBody,
  type OrderEditBody,
  type OrderMoveBody,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';
import { queryOf, type OrderFilters } from './order-filters';

/** Query keys of the order screens. A search text is kept in memory only, never in a URL. */
export const orderKeys = {
  /** One list, by every filter and the search text. */
  list: (filters: OrderFilters) => ['orders', 'list', filters] as const,
  /** The related order picker's search text. */
  picker: (q: string) => ['orders', 'picker', q] as const,
  /** One order page. */
  detail: (id: string) => ['orders', 'detail', id] as const,
  /** Every store and channel, for the list filters. */
  filterOptions: ['orders', 'filter-options'] as const,
  /** What the new order form offers. */
  options: ['orders', 'options'] as const,
  /** Every order list and page, for a refresh after a write. */
  all: ['orders'] as const,
};

/**
 * One page of orders, newest first. Without a search text the filters travel in the query string
 * of `GET /api/orders`; with one they travel in the body of `POST /api/orders/search`, because the
 * text may be a phone and a phone never goes in a URL (spec 0013, AC-4, Law 151).
 */
export function listOrders(
  filters: OrderFilters,
  cursor: string | undefined,
  signal?: AbortSignal,
  limit?: number,
) {
  const query = queryOf(filters, cursor, limit);
  if (filters.q) {
    return apiRequest('POST', '/api/orders/search', OrderListResponse, { body: query, signal });
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const item of value) params.append(name, String(item));
    else params.set(name, String(value));
  }
  return apiRequest('GET', `/api/orders?${params}`, OrderListResponse, { signal });
}

/** `GET /api/orders/:id`: the order page. */
export const getOrder = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', `/api/orders/${encodeURIComponent(id)}`, OrderDetail, { signal });

/** `GET /api/orders/filter-options` (`orders.view`): every store and channel, Shopify ones included. */
export const getOrderFilterOptions = (signal?: AbortSignal) =>
  apiRequest('GET', '/api/orders/filter-options', OrderFilterOptions, { signal });

/** `GET /api/orders/options` (`orders.confirm`): stores, channels, gift reasons, tax settings. */
export const getOrderOptions = (signal?: AbortSignal) =>
  apiRequest('GET', '/api/orders/options', OrderOptions, { signal });

/** `POST /api/orders` (`orders.confirm`): a manual sale; a repeat of the same `clientRef` returns the first order. */
export const createOrder = (body: CreateManualOrderBody) =>
  apiRequest('POST', '/api/orders', CreatedOrder, { body });

/** `POST /api/orders/gifted` (`orders.gift`). */
export const createGiftedOrder = (body: CreateGiftedOrderBody) =>
  apiRequest('POST', '/api/orders/gifted', CreatedOrder, { body });

/** `POST /api/orders/:id/edits` (`orders.confirm`): one or more edit operations in one transaction; answers the order page. */
export const editOrder = (id: string, body: OrderEditBody) =>
  apiRequest('POST', `/api/orders/${encodeURIComponent(id)}/edits`, OrderDetail, { body });

/** `POST /api/orders/:id/cancel` (`orders.confirm`): a cancel reason, and for `duplicate` the order it duplicates. */
export const cancelOrder = (id: string, body: CancelOrderBody) =>
  apiRequest('POST', `/api/orders/${encodeURIComponent(id)}/cancel`, OrderDetail, { body });

/** The moves that carry only the concurrency token. */
export type OrderMove = 'confirm' | 'pack' | 'unpack';

/** `POST /api/orders/:id/confirm`, `/pack`, or `/unpack`: `orders.confirm` for the first, `fulfillment.work` for the others. */
export const moveOrder = (id: string, move: OrderMove, body: OrderMoveBody) =>
  apiRequest('POST', `/api/orders/${encodeURIComponent(id)}/${move}`, OrderDetail, { body });
