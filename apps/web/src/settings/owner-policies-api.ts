import {
  OwnerPoliciesResponse,
  PutOwnerPolicyAnswer,
  type LocationOwnerType,
  type PutOwnerPolicyBody,
} from '@ssdashboard/contracts';
import { apiRequest } from '@/api/client';

/** Query keys of the Location owner types section. */
export const ownerPolicyKeys = {
  /** Every owner type's policy, for one invalidation. */
  all: ['inventory', 'owner-policies'] as const,
};

/** Every location owner type's policy with its locked fields (needs `settings.manage`). */
export function listOwnerPolicies(signal?: AbortSignal) {
  return apiRequest('GET', '/api/inventory/owner-policies', OwnerPoliciesResponse, { signal });
}

/**
 * Writes one owner type's policy (spec 0009, AC-24): the whole row, the reason, and the
 * `updatedAt` the screen showed as `expectedUpdatedAt` (409 `STALE_SETTING` when it changed).
 */
export function putOwnerPolicy(ownerType: LocationOwnerType, body: PutOwnerPolicyBody) {
  return apiRequest(
    'PUT',
    `/api/inventory/owner-policies/${encodeURIComponent(ownerType)}`,
    PutOwnerPolicyAnswer,
    { body },
  );
}
