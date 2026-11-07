import { UnprocessableEntityException } from '@nestjs/common';
import { MeResponse } from '@ssdashboard/contracts';
import { describe, expect, it, vi } from 'vitest';
import { assertLanguageEnabled } from '../../platform/languages.js';
import { Access } from '../../platform/access/access.js';
import type { SettingsService } from '../../platform/settings/settings.service.js';
import type { AuthenticatedRequest } from './current-staff.js';
import { MeController } from './me.controller.js';
import type { ProfileService } from './profile.service.js';

const STAFF = {
  id: '0190c0de-0000-7000-8000-000000000001',
  name: 'Sam',
  email: 'sam@example.com',
  phone: null,
  staffCode: 'S1',
  language: null,
  twoFactorEnabled: false,
  mustChangePassword: false,
  home: 'backoffice',
  sessionId: 'session-1',
} as const;

const request = { staff: STAFF } as unknown as AuthenticatedRequest;
const access = new Access({
  userId: STAFF.id,
  hats: ['warehouse', 'support'],
  grants: [],
  partnerAccountId: null,
});

function setup() {
  const update = vi.fn(() => Promise.resolve());
  const controller = new MeController({ update } as unknown as ProfileService);
  return { controller, update };
}

describe('MeController (AC-19, AC-25)', () => {
  it('reads the signed in person without the session id', () => {
    const { controller } = setup();

    const me = controller.read(request, access);

    expect(me).toMatchObject({ name: 'Sam', email: 'sam@example.com', partnerAccountId: null });
    expect(me).not.toHaveProperty('sessionId');
    expect(me).not.toHaveProperty('role');
    expect(MeResponse.parse(me).home).toBe('backoffice');
  });

  it('answers the hats and the sorted effective permissions of the Access (spec 0008, AC-11)', () => {
    const { controller } = setup();

    const me = controller.read(request, access);

    expect(me.hats).toEqual(['support', 'warehouse']);
    expect(me.permissions).toEqual([...access.permissions]);
    expect(me.permissions).toEqual([...me.permissions].sort());
    expect(me.permissions).toContain('stock.receive');
    expect(me.permissions).not.toContain('cost.view');
  });

  it('saves the change for the signed in person only, and answers with the new profile', async () => {
    const { controller, update } = setup();

    const me = await controller.update(
      { name: 'Samira', phone: '+20 100 123 4567', language: 'ar' },
      request,
      access,
    );

    expect(update).toHaveBeenCalledWith(STAFF.id, {
      name: 'Samira',
      phone: '+20 100 123 4567',
      language: 'ar',
    });
    expect(me).toMatchObject({
      name: 'Samira',
      phone: '+20 100 123 4567',
      language: 'ar',
      email: 'sam@example.com',
      hats: ['support', 'warehouse'],
      staffCode: 'S1',
    });
  });

  it('keeps what was not sent, and shows a cleared field as null', async () => {
    const { controller } = setup();

    const me = await controller.update(
      { phone: null },
      {
        staff: { ...STAFF, phone: '+20 100 000 0000', language: 'ar' },
      } as unknown as AuthenticatedRequest,
      access,
    );

    expect(me).toMatchObject({ phone: null, language: 'ar', name: 'Sam' });
  });
});

describe('assertLanguageEnabled (AC-12, AC-19)', () => {
  const settings = (languages: string[] | Error) =>
    ({
      read: vi.fn(() =>
        languages instanceof Error ? Promise.reject(languages) : Promise.resolve({ languages }),
      ),
    }) as unknown as SettingsService;

  it('accepts an enabled language, and nothing to check', async () => {
    await expect(assertLanguageEnabled(settings(['en', 'ar']), 'ar')).resolves.toBeUndefined();
    await expect(assertLanguageEnabled(settings(['en']), undefined)).resolves.toBeUndefined();
    await expect(assertLanguageEnabled(settings(['en']), null)).resolves.toBeUndefined();
  });

  it('refuses a language the install has not enabled with 422 INVALID_LANGUAGE', async () => {
    const failure = await assertLanguageEnabled(settings(['en']), 'fr').catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(UnprocessableEntityException);
    expect((failure as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'INVALID_LANGUAGE',
    });
  });

  it('trusts only English when settings cannot be read', async () => {
    await expect(assertLanguageEnabled(settings(new Error('down')), 'en')).resolves.toBeUndefined();
    await expect(assertLanguageEnabled(settings(new Error('down')), 'ar')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
