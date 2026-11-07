import { LocationOwnerType } from '@ssdashboard/contracts';
import { describe, expect, it } from 'vitest';
import {
  LocationPolicyError,
  LocationPolicyService,
  requiredPartyRole,
} from './location-policy.service.js';

describe('requiredPartyRole', () => {
  it('maps every owner type to the party role it needs, and the brand to none', () => {
    expect(LocationOwnerType.options.map((ownerType) => requiredPartyRole(ownerType))).toEqual([
      null,
      'is_consignment_partner',
      'is_wholesale_customer',
    ]);
  });
});

describe('LocationPolicyService.assertCanCreate', () => {
  // A connection is never reached: these cases fail before any query.
  const service = new LocationPolicyService({ db: {} } as never, {} as never);
  const code = async (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => (error instanceof LocationPolicyError ? error.code : String(error)),
    );

  it('refuses a party on the brand own location', async () => {
    expect(await code(service.assertCanCreate({ partyId: 'p' }))).toBe('PartyRoleMismatch');
  });

  it('refuses a partner location without a party', async () => {
    expect(await code(service.assertCanCreate({ ownerType: 'consignment_partner' }))).toBe(
      'PartyRoleMismatch',
    );
  });
});
