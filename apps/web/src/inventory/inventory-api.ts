import {
  LocationDetail,
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
  type ChangeSkuCodeRequest,
  type LocationStatus,
  type SkuStatus,
  type UpdateLocationRequest,
  type UpdateSkuRequest,
} from '@ssdashboard/contracts';
import { apiRequest, withBusyRetry } from '@/api/client';
import type { LocationChoice } from '@/shell/current-location';

/** Query keys, so a write invalidates exactly what it changed. */
export const inventoryKeys = {
  stock: (locationId: LocationChoice, skuId: string | null, includeZero: boolean) =>
    ['stock', locationId, skuId, includeZero] as const,
  stockAll: ['stock'] as const,
  skuSearch: (q: string) => ['skus', 'search', q] as const,
  skus: ['skus'] as const,
  skuList: (q: string, status: SkuStatus) => ['skus', 'list', q, status] as const,
  sku: (id: string) => ['skus', 'detail', id] as const,
  skuUsage: (id: string) => ['skus', 'usage', id] as const,
  skuStock: (id: string) => ['skus', 'stock', id] as const,
  skuMovements: (id: string) => ['skus', 'movements', id] as const,
  locationList: (status: LocationStatus) => ['locations', 'list', status] as const,
  locations: ['locations'] as const,
  receiptsRoot: ['stock-receipts'] as const,
  receipt: (id: string) => ['stock-receipts', id] as const,
  receipts: (locationId: LocationChoice, q: string) =>
    ['stock-receipts', 'list', locationId, q] as const,
  receiptsAll: ['stock-receipts', 'list'] as const,
};

/** The Stock page filters (AC-9): `skuId` narrows to one SKU, `includeZero` adds rows back at 0. */
export interface StockFilters {
  skuId: string | null;
  includeZero: boolean;
}

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

export const createSku = (body: CreateProductRequest) =>
  apiRequest('POST', '/api/products', SkuDetail, { body });

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

export const getReceipt = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', `/api/stock-receipts/${encodeURIComponent(id)}`, StockReceiptDetail, {
    signal,
  });

const noContent = { parse: (): void => undefined };
const skuPath = (id: string) => `/api/skus/${encodeURIComponent(id)}`;
const locationPath = (id: string) => `/api/locations/${encodeURIComponent(id)}`;

/** The SKU list page: search by code prefix or name, active or archived, 50 a page (AC-13). */
export function listSkus(
  q: string,
  status: SkuStatus,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: '50', status });
  if (q.trim()) params.set('q', q.trim());
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/skus?${params}`, SkuListResponse, { signal });
}

export const getSku = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', skuPath(id), SkuDetail, { signal });

/** `body.updatedAt` is the value read with the SKU, sent back unchanged (AC-2). */
export const updateSku = (id: string, body: UpdateSkuRequest) =>
  apiRequest('PATCH', skuPath(id), SkuDetail, { body });

export const deleteSku = (id: string) => apiRequest('DELETE', skuPath(id), noContent);

export const getSkuUsage = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', `${skuPath(id)}/usage`, SkuUsage, { signal });

/** Admin only. Keyed by the SKU, so the busy retry is safe. */
export const changeSkuCode = (id: string, body: ChangeSkuCodeRequest) =>
  withBusyRetry(() => apiRequest('PATCH', `${skuPath(id)}/code`, SkuDetail, { body }));

export const setSkuArchived = (id: string, archived: boolean) =>
  withBusyRetry(() =>
    apiRequest('POST', `${skuPath(id)}/${archived ? 'archive' : 'unarchive'}`, SkuDetail),
  );

export const getSkuStock = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', `${skuPath(id)}/stock`, SkuStockResponse, { signal });

export function listSkuMovements(id: string, cursor: string | undefined, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `${skuPath(id)}/movements?${params}`, SkuMovementsResponse, {
    signal,
  });
}

/** The Locations page. `archived` is admin only. */
export function listLocations(
  status: LocationStatus,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: '100', status });
  if (cursor) params.set('cursor', cursor);
  return apiRequest('GET', `/api/locations?${params}`, LocationListResponse, { signal });
}

export const updateLocation = (id: string, body: UpdateLocationRequest) =>
  apiRequest('PATCH', locationPath(id), LocationDetail, { body });

export const setLocationArchived = (id: string, archived: boolean) =>
  withBusyRetry(() =>
    apiRequest('POST', `${locationPath(id)}/${archived ? 'archive' : 'unarchive'}`, LocationDetail),
  );

export const deleteLocation = (id: string) => apiRequest('DELETE', locationPath(id), noContent);
