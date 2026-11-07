import { MeResponse } from '@ssdashboard/contracts';
import { describe, expect, it, vi } from 'vitest';
import { Access } from '../../platform/access/access.js';
import type { PartnerRequest } from './current-staff.js';
import { PartnerMeController } from './partner-me.controller.js';
import type { ProfileService } from './profile.service.js';

const ACCOUNT = '0190c0de-0000-7000-8000-0000000000aa';
const PARTNER = {
  userId: '0190c0de-0000-7000-8000-000000000002',
  partnerAccountId: ACCOUNT,
  name: 'Pat',
  email: 'pat@example.com',
  phone: null,
  language: 'ar',
  twoFactorEnabled: false,
  mustChangePassword: false,
  home: 'partner',
  sessionId: 'session-2',
} as const;

const request = { partner: PARTNER } as unknown as PartnerRequest;
const access = new Access({
  userId: PARTNER.userId,
  hats: ['partner'],
  grants: [],
  partnerAccountId: ACCOUNT,
});

function setup() {
  const update = vi.fn(() => Promise.resolve());
  const controller = new PartnerMeController({ update } as unknown as ProfileService);
  return { controller, update };
}

describe('PartnerMeController (spec 0008, AC-9 and AC-11)', () => {
  it('answers the same MeResponse as /api/me, with the account of the hat row and no staff code', () => {
    const { controller } = setup();

    const me = MeResponse.parse(controller.read(request, access));

    expect(me).toEqual({
      id: PARTNER.userId,
      name: 'Pat',
      email: 'pat@example.com',
      hats: ['partner'],
      permissions: ['partner.submit_sales', 'partner.view_own'],
      partnerAccountId: ACCOUNT,
      phone: null,
      staffCode: null,
      language: 'ar',
      twoFactorEnabled: false,
      mustChangePassword: false,
      home: 'partner',
    });
  });

  it('saves the person’s own name, phone and language by their user id', async () => {
    const { controller, update } = setup();

    const me = await controller.update({ name: 'Pat B', phone: null }, request, access);

    expect(update).toHaveBeenCalledWith(PARTNER.userId, { name: 'Pat B', phone: null });
    expect(me).toMatchObject({ name: 'Pat B', phone: null, partnerAccountId: ACCOUNT });
  });
});
