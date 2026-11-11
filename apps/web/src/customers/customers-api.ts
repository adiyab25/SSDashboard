import {
  CustomerMergeResponse,
  CustomerProfile,
  CustomerSearchResponse,
  CustomerUndoMergeResponse,
  MergeSuggestionPage,
  type CustomerMergeRequest,
  type CustomerSearchRequest,
  type CustomerUndoMergeRequest,
  type MergeSuggestionDismissRequest,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** Query keys of the customer screens. */
export const customerKeys = {
  /** Every customer query: a merge or an undo refreshes them all. */
  all: ['customers'] as const,
  /** The open merge suggestions (the To review tab). */
  suggestions: ['customers', 'merge-suggestions'] as const,
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

/** `GET /api/customers/merge-suggestions`: open suggestions oldest first, 25 a page, with the open count. */
export function listMergeSuggestions(cursor: string | undefined, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '25', ...(cursor && { cursor }) });
  return apiRequest(
    'GET',
    `/api/customers/merge-suggestions?${query.toString()}`,
    MergeSuggestionPage,
    {
      signal,
    },
  );
}

/** `POST /api/customers/merges`: merges `mergedId` into `survivorId` (ids and codes only, no personal data). */
export const mergeCustomers = (body: CustomerMergeRequest) =>
  apiRequest('POST', '/api/customers/merges', CustomerMergeResponse, { body });

/** `POST /api/customers/merges/:id/undo`: puts the merged record back; the reason code is required. */
export const undoCustomerMerge = (mergeId: string, body: CustomerUndoMergeRequest) =>
  apiRequest(
    'POST',
    `/api/customers/merges/${encodeURIComponent(mergeId)}/undo`,
    CustomerUndoMergeResponse,
    { body },
  );

/** `POST /api/customers/merge-suggestions/:id/dismiss`: answers 204 with no body. */
export const dismissMergeSuggestion = (id: string, body: MergeSuggestionDismissRequest) =>
  apiRequest(
    'POST',
    `/api/customers/merge-suggestions/${encodeURIComponent(id)}/dismiss`,
    { parse: () => undefined },
    { body },
  );
