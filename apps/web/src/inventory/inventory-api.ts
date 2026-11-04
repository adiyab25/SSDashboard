import {
  LocationDetail,
  SkuDetail,
  SkuListResponse,
  StockListResponse,
  StockReceiptDetail,
  StockReceiptListResponse,
  type CreateLocationRequest,
  type CreateProductRequest,
  type CreateStockReceiptRequest,
} from '@ssdashboard/contracts';
import { apiRequest, withBusyRetry } from '@/api/client';
import type { LocationChoice } from '@/shell/current-location';

/** Query keys, so a write invalidates exactly what it changed. */
export const inventoryKeys = {
  stock: (locationId: LocationChoice) => ['stock', locationId] as const,
  stockAll: ['stock'] as const,
  skuSearch: (q: string) => ['skus', 'search', q] as const,
  skus: ['skus'] as const,
  receipt: (id: string) => ['stock-receipts', id] as const,
  receipts: (locationId: LocationChoice, q: string) =>
    ['stock-receipts', 'list', locationId, q] as const,
  receiptsAll: ['stock-receipts', 'list'] as const,
};

export function listStock(
  locationId: LocationChoice,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: '50' });
  if (locationId !== 'all') params.set('locationId', locationId);
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
