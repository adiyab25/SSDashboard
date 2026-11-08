import {
  CustomerProfile,
  CustomerSearchResponse,
  type CustomerSearchRequest,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** Query keys of the customer screens. */
export const customerKeys = {
  /** One search: its kind and the text typed (kept in memory only, never in a URL). */
  search: (kind: 'phone' | 'name', text: string) => ['customers', 'search', kind, text] as const,
  /** One customer's profile, by the id asked. */
  profile: (id: string) => ['customers', 'profile', id] as const,
};

/**
 * `POST /api/customers/search` by phone or by name fragment, 25 a page. A POST on purpose: the
 * phone or name travels in the body and never lands in a URL, a proxy log, or browser history.
 */
export function searchCustomers(
  by: { phone: string } | { nameContains: string },
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const body: Partial<CustomerSearchRequest> = { ...by, ...(cursor && { cursor }), limit: 25 };
  return apiRequest('POST', '/api/customers/search', CustomerSearchResponse, { body, signal });
}

/** `GET /api/customers/:id`: the canonical customer, with `resolvedFrom` when the id was a merged record. */
export const getCustomer = (id: string, signal?: AbortSignal) =>
  apiRequest('GET', `/api/customers/${encodeURIComponent(id)}`, CustomerProfile, { signal });
