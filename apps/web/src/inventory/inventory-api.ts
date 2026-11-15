import {
  HoldOpenOrdersResult,
  LocationDetail,
  OnlineGateView,
  OnlineStatusResponse,
  StopOnlineResponse,
  LocationListResponse,
  SkuDetail,
  SkuListResponse,
  SkuMovementsResponse,
  SkuStockResponse,
  SkuUsage,
  StockListResponse,
  StockReceiptDetail,
  StockReceiptListResponse,
  type CreateLocationRequest,
  type CreateProductRequest,
  type CreateStockReceiptRequest,
  type HoldOpenOrdersBody,
  type MakeLocationOnlineRequest,
  type OnlineGateAction,
  type ChangeSkuCodeRequest,
  type LocationStatus,
  type SeasonFilter,
  type SkuStatus,
  type UpdateLocationRequest,
  type UpdateSkuRequest,
} from '@ssdashboard/contracts';
import { apiRequest, withBusyRetry } from '@/api/client';
import type { LocationChoice } from '@/shell/current-location-provider';

/** What the SKU list page asks for (spec 0012, AC-3 and AC-4); an empty `q` and an absent filter are not sent. */
export interface SkuListFilters {
  q: string;
  status: SkuStatus;
  /** A season id, or `none` for styles with no season. */
  seasonId?: SeasonFilter;
  productGroupId?: string;
}

/** Query keys, so a write invalidates exactly what it changed. */
export const inventoryKeys = {
  /** Stock rows for a location (or all), SKU filter, and zero rows choice. */
  stock: (locationId: LocationChoice, skuId: string | null, includeZero: boolean) =>
    ['stock', locationId, skuId, includeZero] as const,
  stockAll: ['stock'] as const,
  /** The receipt line picker's search results for one query. */
  skuSearch: (q: string) => ['skus', 'search', q] as const,
  skus: ['skus'] as const,
  /** The SKU list page for one search, status, and season and group filter. */
  skuList: (filters: SkuListFilters) =>
    ['skus', 'list', filters.q, filters.status, filters.seasonId, filters.productGroupId] as const,
  /** One SKU's detail. */
  sku: (id: string) => ['skus', 'detail', id] as const,
  /** What a SKU is used by, for the delete check. */
  skuUsage: (id: string) => ['skus', 'usage', id] as const,
  /** One SKU's stock per location. */
  skuStock: (id: string) => ['skus', 'stock', id] as const,
  /** One SKU's movement history. */
  skuMovements: (id: string) => ['skus', 'movements', id] as const,
  /** The Locations page list for one status. */
  locationList: (status: LocationStatus) => ['locations', 'list', status] as const,
  locations: ['locations'] as const,
  receiptsRoot: ['stock-receipts'] as const,
  /** One stock receipt's detail. */
  receipt: (id: string) => ['stock-receipts', id] as const,
  /** The receipts list for a location (or all) and a search. */
  receipts: (locationId: LocationChoice, q: string) =>
    ['stock-receipts', 'list', locationId, q] as const,
  receiptsAll: ['stock-receipts', 'list'] as const,
  /** Which location feeds online stock, or none (spec 0011 AC-20). */
  onlineStatus: ['online-status'] as const,
  /** One location's online gate. */
  onlineGate: (locationId: string) => ['locations', 'online-gate', locationId] as const,
};

/** The Stock page filters (AC-9): `skuId` narrows to one SKU, `includeZero` adds rows back at 0. */
export interface StockFilters {
  skuId: string | null;
  includeZero: boolean;
}

/** One page of stock rows, 50 a page, narrowed by location and the Stock page filters. */
export function listStock(
  locationId: LocationChoice,
  filters: StockFilters,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: '50' });
  if (locationId !== 'all') params.set('locationId', locationId);
  if (filters.skuId) params.set('skuId', filters.skuId);
  if (filters.includeZero) params.set('includeZero', 'true');
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/stock?${params}`, StockListResponse, { signal });
}

/** The receipt line picker: up to 20 active SKUs by code prefix or name (AC-13). */
export function searchSkus(q: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '20' });
  if (q.trim()) params.set('q', q.trim());
  return apiRequest('GET', `/api/skus?${params}`, SkuListResponse, { signal });
}

/** `POST /api/products`: a new SKU with its first product. */
export const createSku = (body: CreateProductRequest) =>
  apiRequest('POST', '/api/products', SkuDetail, { body });

/** `POST /api/locations`: a new warehouse or shop (`catalog.manage`). */
export const createLocation = (body: CreateLocationRequest) =>
  apiRequest('POST', '/api/locations', LocationDetail, { body });

/** `key` is the form's idempotency key, kept across retries of the same receipt (AC-6). */
export const postReceipt = (key: string, body: CreateStockReceiptRequest) =>
  withBusyRetry(() =>
    apiRequest('POST', '/api/stock-receipts', StockReceiptDetail, {
      body,
      headers: { 'idempotency-key': key },
    }),
  );

/** One page of stock receipts, 50 a page, narrowed by location and search. */
export function listReceipts(
  locationId: LocationChoice,
  q: string,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: '50' });
  if (locationId !== 'all') params.set('locationId', locationId);
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/stock-receipts?${params}`, StockReceiptListResponse, { signal });
}

/** Admin only (AC-8). A void is keyed by the receipt, so the busy retry is safe too. */
export const voidReceipt = (id: string, reason: string) =>
  withBusyRetry(() =>
    apiRequest('POST', `/api/stock-receipts/${encodeURIComponent(id)}/void`, StockReceiptDetail, {
      body: { reason },
    }),
  );

/** One stock receipt with its lines. */
export const getReceipt = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', `/api/stock-receipts/${encodeURIComponent(id)}`, StockReceiptDetail, {
    signal,
  });

const noContent = { parse: (): void => undefined };
const skuPath = (id: string) => `/api/skus/${encodeURIComponent(id)}`;
const locationPath = (id: string) => `/api/locations/${encodeURIComponent(id)}`;

/**
 * The SKU list page: search by name, SKU code, or barcode, filtered by status, season, and
 * product group, 50 a page (spec 0006 AC-13, spec 0012 AC-3 and AC-4).
 */
export function listSkus(
  filters: SkuListFilters,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: '50', status: filters.status });
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.seasonId) params.set('seasonId', filters.seasonId);
  if (filters.productGroupId) params.set('productGroupId', filters.productGroupId);
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/skus?${params}`, SkuListResponse, { signal });
}

/** One SKU with the `updatedAt` an edit must send back. */
export const getSku = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', skuPath(id), SkuDetail, { signal });

/** `body.updatedAt` is the value read with the SKU, sent back unchanged (AC-2). */
export const updateSku = (id: string, body: UpdateSkuRequest) =>
  apiRequest('PATCH', skuPath(id), SkuDetail, { body });

/** Deletes a SKU that has no stock history (`catalog.manage`). */
export const deleteSku = (id: string) => apiRequest('DELETE', skuPath(id), noContent);

/** What still uses a SKU, so the dialog can say why it cannot be deleted. */
export const getSkuUsage = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', `${skuPath(id)}/usage`, SkuUsage, { signal });

/** Admin only. Keyed by the SKU, so the busy retry is safe. */
export const changeSkuCode = (id: string, body: ChangeSkuCodeRequest) =>
  withBusyRetry(() => apiRequest('PATCH', `${skuPath(id)}/code`, SkuDetail, { body }));

/** Archives or unarchives a SKU (`catalog.manage`). Keyed by the SKU, so the busy retry is safe. */
export const setSkuArchived = (id: string, archived: boolean) =>
  withBusyRetry(() =>
    apiRequest('POST', `${skuPath(id)}/${archived ? 'archive' : 'unarchive'}`, SkuDetail),
  );

/** One SKU's on-hand quantity per location, with cost fields for people holding `cost.view`. */
export const getSkuStock = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', `${skuPath(id)}/stock`, SkuStockResponse, { signal });

/** One page of a SKU's movement history, newest first, 50 a page. */
export function listSkuMovements(id: string, cursor: string | undefined, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `${skuPath(id)}/movements?${params}`, SkuMovementsResponse, {
    signal,
  });
}

/** The Locations page. `archived` needs `catalog.manage`. */
export function listLocations(
  status: LocationStatus,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: '100', status });
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/locations?${params}`, LocationListResponse, { signal });
}

/** `PATCH /api/locations/:id`: rename or retype a location (`catalog.manage`). */
export const updateLocation = (id: string, body: UpdateLocationRequest) =>
  apiRequest('PATCH', locationPath(id), LocationDetail, { body });

/** Archives or unarchives a location (`catalog.manage`). Keyed by the location, so the busy retry is safe. */
export const setLocationArchived = (id: string, archived: boolean) =>
  withBusyRetry(() =>
    apiRequest('POST', `${locationPath(id)}/${archived ? 'archive' : 'unarchive'}`, LocationDetail),
  );

/** Deletes a location with no stock or documents (`catalog.manage`). */
export const deleteLocation = (id: string) => apiRequest('DELETE', locationPath(id), noContent);

/** `GET /api/stock/online-status` (`stock.view`): the online location, or null (spec 0011 AC-20). */
export const getOnlineStatus = (signal?: AbortSignal) =>
  apiRequest('GET', '/api/stock/online-status', OnlineStatusResponse, { signal });

/** `GET /api/locations/:id/online-gate` (`catalog.manage`): the checks and counts (spec 0011 AC-19). */
export const getOnlineGate = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', `${locationPath(id)}/online-gate`, OnlineGateView, { signal });

/** `POST /api/locations/:id/confirm-stock`: a manager confirms the location's stock is counted. */
export const confirmLocationStock = (id: string) =>
  apiRequest('POST', `${locationPath(id)}/confirm-stock`, LocationDetail, { body: {} });

/** `POST /api/locations/:id/make-online`: moves the online flag here, with the count the manager saw. */
export const makeLocationOnline = (id: string, body: MakeLocationOnlineRequest) =>
  apiRequest('POST', `${locationPath(id)}/make-online`, LocationDetail, { body });

/** `POST /api/locations/online/stop`: turns online stock off, with a written reason. */
export const stopOnlineStock = (reason: string) =>
  apiRequest('POST', '/api/locations/online/stop', StopOnlineResponse, { body: { reason } });

/** The route the orders module's `orders.open_orders_held` check points to (spec 0013 AC-26). */
export const HOLD_OPEN_ORDERS_PATH = '/api/orders/hold-open-orders';

/**
 * What a gate action answered: `held` carries the counts of `hold-open-orders` for the dialog to
 * show; `done` is any other action, whose answer the dialog does not read.
 */
export type GateActionResult = { kind: 'held'; result: HoldOpenOrdersResult } | { kind: 'done' };

/**
 * Runs the route a failed gate check points to, for the candidate `locationId`; the dialog reads
 * the gate again afterwards. A route the web knows gets its own body and has its answer parsed
 * with the contract schema: `hold-open-orders` takes `{ locationId }` (a repeat holds nothing
 * twice, so the busy retry is safe). Any other route keeps the empty body and an unread answer.
 * It must never send a body a route has not declared.
 */
export async function runGateAction(
  action: Pick<OnlineGateAction, 'method' | 'path'>,
  locationId: string,
): Promise<GateActionResult> {
  if (action.method === 'POST' && action.path === HOLD_OPEN_ORDERS_PATH) {
    const result = await withBusyRetry(() =>
      apiRequest('POST', HOLD_OPEN_ORDERS_PATH, HoldOpenOrdersResult, {
        body: { locationId } satisfies HoldOpenOrdersBody,
      }),
    );
    return { kind: 'held', result };
  }
  await apiRequest(action.method, action.path, noContent, { body: {} });
  return { kind: 'done' };
}
